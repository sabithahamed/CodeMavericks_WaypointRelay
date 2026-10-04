import { Router } from 'express';
import { z } from 'zod';
import { HttpError, requireRole } from '../auth.js';
import { one, q, tx } from '../db.js';
import { logEvent } from '../services/events.js';
import { publishedView } from '../services/published.js';

const ah = (fn: (req: any, res: any) => Promise<unknown>) => (req: any, res: any, next: any) => fn(req, res).catch(next);

/**
 * Illustrative order catalogue. The source data has order totals but no SKU master, so these
 * handling units convert a store's quantities into the weight and volume the planner needs.
 */
export const CATALOGUE = {
  Fresh: [
    { sku: 'FR-DRY', name: 'Dry grocery case', temp: 'ambient', kg: 8.2, m3: 0.042 },
    { sku: 'FR-BEV', name: 'Beverage case', temp: 'ambient', kg: 11.5, m3: 0.03 },
    { sku: 'FR-DAIRY', name: 'Dairy crate', temp: 'chilled', kg: 5.6, m3: 0.03 },
    { sku: 'FR-MEAT', name: 'Meat & poultry box', temp: 'chilled', kg: 8.0, m3: 0.035 },
    { sku: 'FR-PROD', name: 'Produce crate (chilled)', temp: 'chilled', kg: 6.5, m3: 0.045 },
  ],
  Style: [
    { sku: 'ST-RAIL', name: 'Hanging garment rail', temp: 'ambient', kg: 22, m3: 0.9 },
    { sku: 'ST-CTN', name: 'Garment carton', temp: 'ambient', kg: 11, m3: 0.14 },
  ],
  Tech: [
    { sku: 'TE-LARGE', name: 'Large appliance', temp: 'ambient', kg: 68, m3: 0.62 },
    { sku: 'TE-SMALL', name: 'Electronics carton', temp: 'ambient', kg: 7.5, m3: 0.05 },
  ],
} as const;

export const store = Router();
store.use(requireRole('store'));

async function outletOf(req: any) {
  const o = await one('SELECT * FROM outlets WHERE outlet_id = $1', [req.user.outlet_id]);
  if (!o) throw new HttpError(404, 'Your account is not linked to an outlet.');
  return o;
}

store.get('/catalogue', ah(async (req, res) => {
  const outlet = await outletOf(req);
  res.json({ outlet, items: CATALOGUE[outlet.brand as keyof typeof CATALOGUE], cutoff: '16:00' });
}));

store.get('/orders', ah(async (req, res) => {
  const outlet = await outletOf(req);
  const orders = await q(
    `SELECT o.*, d.delivery_date, d.status AS day_status, d.id AS day_id FROM orders o JOIN delivery_days d ON d.id = o.day_id
      WHERE o.outlet_id = $1 ORDER BY d.delivery_date DESC, o.id`,
    [outlet.outlet_id],
  );
  const views = new Map<number, Awaited<ReturnType<typeof publishedView>>>();
  for (const id of new Set(orders.map((o) => o.day_id))) views.set(id, await publishedView(id));
  const records = await q(`SELECT DISTINCT ON (order_id) order_id, outcome, delivered_units, condition, recipient, note, recorded_at, received_at, proof_status FROM delivery_records WHERE order_id = ANY($1::text[]) ORDER BY order_id, recorded_at DESC`, [orders.map((o) => o.id)]);
  const receipts = await q('SELECT * FROM receipts WHERE order_id = ANY($1::text[])', [orders.map((o) => o.id)]);
  const events = await q('SELECT * FROM events WHERE order_id = ANY($1::text[]) ORDER BY at', [orders.map((o) => o.id)]);
  res.json({
    outlet,
    orders: orders.map((o) => {
      const pv = views.get(o.day_id);
      const a = pv?.byOrder.get(o.id);
      const d = pv?.deferred.get(o.id) as any;
      return {
        ...o,
        published_version: pv?.version ?? null,
        assignment: a ?? null,
        deferral: d ?? null,
        record: records.find((r) => r.order_id === o.id) ?? null,
        receipt: receipts.find((r) => r.order_id === o.id) ?? null,
        events: events.filter((e) => e.order_id === o.id),
      };
    }),
  });
}));

const OrderBody = z.object({
  temp_requirement: z.enum(['ambient', 'chilled']),
  lines: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1).max(500) })).min(1, 'Add at least one item.'),
});

store.post('/orders', ah(async (req, res) => {
  const body = OrderBody.parse(req.body);
  const outlet = await outletOf(req);
  const items = CATALOGUE[outlet.brand as keyof typeof CATALOGUE];
  const lines = body.lines.map((l) => {
    const item = items.find((i) => i.sku === l.sku);
    if (!item) throw new HttpError(400, `${l.sku} is not in the ${outlet.brand} catalogue.`);
    if (item.temp !== body.temp_requirement) throw new HttpError(400, `${item.name} is ${item.temp}; place it on the ${item.temp} order.`);
    return { ...l, name: item.name, kg: item.kg, m3: item.m3 };
  });
  if (body.temp_requirement === 'chilled' && outlet.brand !== 'Fresh') throw new HttpError(400, 'Only Fresh outlets order chilled goods.');
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const kg = Math.round(lines.reduce((s, l) => s + l.qty * l.kg, 0) * 10) / 10;
  const m3 = Math.round(lines.reduce((s, l) => s + l.qty * l.m3, 0) * 1000) / 1000;

  const result = await tx(async (c) => {
    // Orders join the open run; after the dispatcher closes orders they wait for the following run.
    let day = (await c.query(`SELECT * FROM delivery_days WHERE depot = $1 AND status = 'open' ORDER BY delivery_date LIMIT 1`, [outlet.depot])).rows[0];
    let note = 'Confirmed for the next delivery run.';
    if (!day) {
      const last = (await c.query(`SELECT max(delivery_date) AS d FROM delivery_days WHERE depot = $1`, [outlet.depot])).rows[0].d;
      const next = new Date(`${last}T00:00:00Z`);
      do next.setUTCDate(next.getUTCDate() + 1); while (next.getUTCDay() === 0); // Monday to Saturday
      const date = next.toISOString().slice(0, 10);
      day = (await c.query(`INSERT INTO delivery_days (delivery_date, depot, label) VALUES ($1,$2,'Following run') ON CONFLICT (delivery_date, depot) DO UPDATE SET label = delivery_days.label RETURNING *`, [date, outlet.depot])).rows[0];
      note = `Orders for ${last} are closed, so this order is confirmed for the following run on ${date}.`;
    }
    const seq = (await c.query(`SELECT count(*)::int AS n FROM orders WHERE source = 'store'`)).rows[0].n + 1;
    const id = `WR-${String(seq).padStart(5, '0')}`;
    await c.query(
      `INSERT INTO orders (id, day_id, requested_date, outlet_id, temp_requirement, units, weight_kg, volume_m3, lines, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'store',$10)`,
      [id, day.id, day.delivery_date, outlet.outlet_id, body.temp_requirement, units, kg, m3, JSON.stringify(lines), req.user.id],
    );
    await logEvent(c, { order_id: id, day_id: day.id, kind: 'order_confirmed', user: req.user, message: `Order received and confirmed: ${units} units, ${kg} kg, ${m3} m³ (${body.temp_requirement}). ${note}` });
    return { id, delivery_date: day.delivery_date, note };
  });
  res.status(201).json(result);
}));

const ReceiptBody = z.object({
  status: z.enum(['confirmed', 'issue']),
  received_units: z.number().int().min(0),
  note: z.string().trim().optional(),
});

store.post('/orders/:id/receipt', ah(async (req, res) => {
  const body = ReceiptBody.parse(req.body);
  const outlet = await outletOf(req);
  const order = await one('SELECT * FROM orders WHERE id = $1 AND outlet_id = $2', [req.params.id, outlet.outlet_id]);
  if (!order) throw new HttpError(404, 'Order not found for your outlet.');
  if (body.status === 'issue' && !body.note) throw new HttpError(400, 'Describe the issue so the dispatcher can act on it.');
  const short = body.received_units < order.units;
  const status = body.status === 'confirmed' && short ? 'issue' : body.status;
  await tx(async (c) => {
    await c.query(
      `INSERT INTO receipts (order_id, status, received_units, note, confirmed_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (order_id) DO UPDATE SET status = EXCLUDED.status, received_units = EXCLUDED.received_units, note = EXCLUDED.note, confirmed_at = now()`,
      [order.id, status, body.received_units, body.note ?? null, req.user.id],
    );
    await c.query(`UPDATE orders SET status = $1 WHERE id = $2`, [status === 'confirmed' ? 'received' : 'issue', order.id]);
    const msg = status === 'confirmed' ? `Store confirmed receipt of ${body.received_units} units.` : `Store reported an issue: received ${body.received_units} of ${order.units} units. ${body.note ?? ''}`.trim();
    await logEvent(c, { order_id: order.id, day_id: order.day_id, kind: status === 'confirmed' ? 'received' : 'receipt_issue', user: req.user, message: msg });
    if (status === 'issue') {
      await c.query(`INSERT INTO exceptions (day_id, order_id, kind, message, raised_by) VALUES ($1,$2,'receipt_issue',$3,$4)`, [order.day_id, order.id, `${outlet.outlet_id}: ${msg}`, req.user.id]);
    }
  });
  res.json({ ok: true, status });
}));
