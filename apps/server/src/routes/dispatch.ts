import { Router } from 'express';
import { z } from 'zod';
import { HttpError, requireRole } from '../auth.js';
import { pool, q, tx } from '../db.js';
import { isCompatible } from '../planner/allocate.js';
import { toHHMM } from '../planner/time.js';
import type { Plan } from '../planner/types.js';
import { validatePlan } from '../planner/validate.js';
import { seedDemoDay } from '../seed/seed.js';
import { logEvent } from '../services/events.js';
import { autoPlan, currentDay, describePlan, diffPlans, latestPlan, loadPlanningInputs, moveOrder, saveDraft, workingPlan } from '../services/planning.js';
import { publishedView } from '../services/published.js';

export const dispatch = Router();
dispatch.use(requireRole('dispatcher'));

const ah = (fn: (req: any, res: any) => Promise<unknown>) => (req: any, res: any, next: any) => fn(req, res).catch(next);

async function planState(dayId: number) {
  const { orders, ctx, day } = await loadPlanningInputs(dayId);
  const working = await workingPlan(dayId);
  const published = await latestPlan(dayId, 'published');
  const outlets = await q('SELECT * FROM outlets WHERE depot = $1', [day.depot]);
  const orderRows = await q('SELECT id, status, source, created_at, units FROM orders WHERE day_id = $1', [dayId]);
  const meta = Object.fromEntries(orderRows.map((r) => [r.id, r]));
  return {
    day,
    orders: orders.map((o) => ({ ...o, status: meta[o.id].status, source: meta[o.id].source, created_at: meta[o.id].created_at })),
    outlets,
    vehicles: [...ctx.available].sort().map((id) => ctx.vehicles[id]),
    workshop: day.workshop,
    plan: working ? { version: working.version, status: working.status, ...describePlan(working.plan, orders, ctx) } : null,
    published_version: published?.version ?? null,
  };
}

dispatch.get('/day', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  res.json(await planState(day.id));
}));

dispatch.post('/day/close', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  if (day.status === 'closed') throw new HttpError(409, 'Orders are already closed for this run.');
  await tx(async (c) => {
    await c.query(`UPDATE delivery_days SET status = 'closed', closed_at = now() WHERE id = $1`, [day.id]);
    await logEvent(c, { day_id: day.id, kind: 'orders_closed', user: req.user, message: `Orders closed for ${day.delivery_date}. Later orders wait for the following run.` });
  });
  res.json(await planState(day.id));
}));

dispatch.post('/plan/auto', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  if (day.status !== 'closed') throw new HttpError(409, 'Close orders before planning, so the plan covers the confirmed queue.');
  const { orders, ctx } = await loadPlanningInputs(day.id);
  const working = await workingPlan(day.id);
  const plan = autoPlan(orders, ctx, working?.plan);
  await saveDraft(pool, day.id, plan, 'Automatic allocation');
  res.json(await planState(day.id));
}));

const MoveBody = z.union([
  z.object({ order_id: z.string(), vehicle_id: z.string(), trip_no: z.union([z.literal(1), z.literal(2)]) }),
  z.object({ order_id: z.string(), defer: z.literal(true), reason: z.string().trim().min(5, 'Give a reason the store and next dispatcher can understand.') }),
]);

dispatch.post('/plan/move', ah(async (req, res) => {
  const body = MoveBody.parse(req.body);
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const { orders, ctx } = await loadPlanningInputs(day.id);
  const working = await workingPlan(day.id);
  if (!working) throw new HttpError(409, 'Create a plan first.');
  const next = moveOrder(working.plan, body.order_id, 'defer' in body ? { defer: true, reason: body.reason } : body);
  const before = new Set(validatePlan(working.plan, orders, ctx).map((v) => v.message));
  const introduced = validatePlan(next, orders, ctx).filter((v) => !before.has(v.message));
  if (introduced.length > 0) throw new HttpError(422, introduced[0].message, { violations: introduced });
  await saveDraft(pool, day.id, next);
  res.json(await planState(day.id));
}));

/** Feasible placements for one order, so the dispatcher sees real options rather than errors. */
dispatch.get('/plan/options/:orderId', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const { orders, ctx } = await loadPlanningInputs(day.id);
  const working = await workingPlan(day.id);
  const order = orders.find((o) => o.id === req.params.orderId);
  if (!order || !working) throw new HttpError(404, 'Order or plan not found.');
  const options = [];
  for (const id of [...ctx.available].sort()) {
    const v = ctx.vehicles[id];
    if (!isCompatible(order, v, ctx)) continue;
    for (const trip_no of [1, 2] as const) {
      const next = moveOrder(working.plan, order.id, { vehicle_id: id, trip_no });
      const vio = validatePlan(next, orders, ctx).filter((x) => x.vehicle_id === id);
      const current = working.plan.trips.some((t) => t.vehicle_id === id && t.trip_no === trip_no && t.order_ids.includes(order.id));
      if (!current) options.push({ vehicle_id: id, trip_no, feasible: vio.length === 0, reason: vio[0]?.message ?? null });
    }
  }
  options.sort((a, b) => Number(b.feasible) - Number(a.feasible));
  res.json({ order, options: options.slice(0, 30) });
}));

dispatch.get('/plan/review', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const { orders, ctx } = await loadPlanningInputs(day.id);
  const working = await workingPlan(day.id);
  if (!working) throw new HttpError(409, 'Create a plan first.');
  const published = await latestPlan(day.id, 'published');
  const diff = diffPlans(published?.data ?? null, working.plan, orders);
  res.json({ version: working.version, status: working.status, previous_version: published?.version ?? null, ...describePlan(working.plan, orders, ctx), ...diff });
}));

dispatch.post('/plan/publish', ah(async (req, res) => {
  const note = z.object({ note: z.string().optional() }).parse(req.body).note;
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const { orders, ctx } = await loadPlanningInputs(day.id);
  const working = await workingPlan(day.id);
  if (!working || working.status !== 'draft') throw new HttpError(409, 'There are no unpublished changes.');
  const violations = validatePlan(working.plan, orders, ctx);
  if (violations.length) throw new HttpError(422, `The plan breaks ${violations.length} rule(s). Fix them before publishing.`, { violations });
  const prev = await latestPlan(day.id, 'published');
  const plan: Plan = working.plan;
  const view = describePlan(plan, orders, ctx);

  await tx(async (c) => {
    await c.query(`UPDATE plans SET status = 'published', published_at = now(), published_by = $1, note = COALESCE($2, note) WHERE day_id = $3 AND version = $4`, [req.user.id, note ?? null, day.id, working.version]);
    const prevTrips = new Map<string, string>((prev?.data.trips ?? []).map((t: any) => [`${t.vehicle_id}|${t.trip_no}`, [...t.order_ids].sort().join(',')]));
    const nextKeys = new Set<string>();
    for (const t of view.trips) {
      const key = `${t.vehicle_id}|${t.trip_no}`;
      nextKeys.add(key);
      const changed = prevTrips.get(key) !== [...t.order_ids].sort().join(',');
      await c.query(
        `INSERT INTO trip_runs (day_id, vehicle_id, trip_no, plan_version) VALUES ($1,$2,$3,$4)
         ON CONFLICT (day_id, vehicle_id, trip_no) DO UPDATE SET plan_version = EXCLUDED.plan_version,
           status = CASE WHEN $5 AND trip_runs.status NOT IN ('en_route','completed') THEN 'to_load' ELSE trip_runs.status END`,
        [day.id, t.vehicle_id, t.trip_no, working.version, changed],
      );
    }
    for (const key of prevTrips.keys()) {
      if (!nextKeys.has(key)) {
        const [vid, no] = key.split('|');
        await c.query(`DELETE FROM trip_runs WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3 AND status NOT IN ('en_route','completed')`, [day.id, vid, Number(no)]);
      }
    }
    const diff = diffPlans(prev?.data ?? null, plan, orders);
    const changedIds = new Set(diff.changes.map((x) => x.order_id));
    for (const t of view.trips) {
      for (const id of t.order_ids) {
        await c.query(`UPDATE orders SET status = 'planned' WHERE id = $1 AND status IN ('confirmed','deferred','planned')`, [id]);
        if (changedIds.has(id)) {
          const st = t.schedule?.stops.find((s) => s.order_id === id);
          await logEvent(c, { order_id: id, day_id: day.id, kind: 'planned', user: req.user, message: `Planned on ${t.vehicle_id} trip ${t.trip_no}. Expected arrival ${st ? toHHMM(st.arrival_min) : 'TBC'} (planning estimate, v${working.version}).` });
        }
      }
    }
    for (const d of plan.deferred) {
      await c.query(`UPDATE orders SET status = 'deferred' WHERE id = $1 AND status IN ('confirmed','planned','deferred')`, [d.order_id]);
      if (changedIds.has(d.order_id)) {
        await logEvent(c, { order_id: d.order_id, day_id: day.id, kind: 'deferred', user: req.user, message: `Deferred: ${d.reason}`, data: { code: d.code } });
      }
    }
    await logEvent(c, { day_id: day.id, kind: 'plan_published', user: req.user, message: `Plan v${working.version} published: ${view.summary.served} served, ${view.summary.deferred} deferred.` });
  });
  res.json(await planState(day.id));
}));

dispatch.get('/progress', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const pv = await publishedView(day.id);
  const runs = await q('SELECT * FROM trip_runs WHERE day_id = $1', [day.id]);
  const records = await q(`SELECT DISTINCT ON (order_id) order_id, outcome, delivered_units, recorded_at, received_at, proof_status, condition, note FROM delivery_records ORDER BY order_id, recorded_at DESC`);
  const receipts = await q('SELECT * FROM receipts');
  const exceptions = await q(`SELECT * FROM exceptions WHERE day_id = $1 ORDER BY status, created_at DESC`, [day.id]);
  const orderStatus = Object.fromEntries((await q('SELECT id, status FROM orders WHERE day_id = $1', [day.id])).map((r) => [r.id, r.status]));
  const rec = new Map(records.map((r) => [r.order_id, r]));
  const rcp = new Map(receipts.map((r) => [r.order_id, r]));
  const trips = (pv?.view.trips ?? []).map((t) => {
    const run = runs.find((r) => r.vehicle_id === t.vehicle_id && r.trip_no === t.trip_no);
    const stops = t.order_ids.map((id) => ({ order_id: id, outlet_id: pv!.byOrder.get(id) && pv!.orders.find((o) => o.id === id)?.outlet_id, eta: pv!.byOrder.get(id)?.eta, status: orderStatus[id], record: rec.get(id) ?? null, receipt: rcp.get(id) ?? null }));
    const times = stops.map((s) => s.record?.received_at).filter(Boolean).map((x: any) => new Date(x).getTime());
    return { vehicle_id: t.vehicle_id, trip_no: t.trip_no, brand: t.brand, district: t.district, status: run?.status ?? 'to_load', plan_version: run?.plan_version, loader_ack_version: run?.loader_ack_version, driver_ack_version: run?.driver_ack_version, depart: t.schedule ? toHHMM(t.schedule.depart_min) : null, stops, last_update: times.length ? new Date(Math.max(...times)).toISOString() : null };
  });
  res.json({ day, published_version: pv?.version ?? null, trips, exceptions, deferred: pv ? [...pv.deferred.values()] : [] });
}));

dispatch.post('/exceptions/:id/resolve', ah(async (req, res) => {
  const body = z.object({ action: z.enum(['accept', 'defer_order']), resolution: z.string().trim().min(3) }).parse(req.body);
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const ex = (await q('SELECT * FROM exceptions WHERE id = $1', [req.params.id]))[0];
  if (!ex || ex.status !== 'open') throw new HttpError(404, 'Open exception not found.');
  await tx(async (c) => {
    await c.query(`UPDATE exceptions SET status = 'resolved', resolution = $1, resolved_at = now() WHERE id = $2`, [body.resolution, ex.id]);
    if (ex.kind === 'loading_shortfall' && body.action === 'accept' && ex.vehicle_id) {
      await c.query(`UPDATE trip_runs SET status = 'loading' WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3 AND status = 'held'`, [day.id, ex.vehicle_id, ex.trip_no]);
    }
    if (ex.order_id) await logEvent(c, { order_id: ex.order_id, day_id: day.id, kind: 'exception_resolved', user: req.user, message: `Dispatcher decision: ${body.resolution}` });
  });
  if (body.action === 'defer_order' && ex.order_id) {
    const working = await workingPlan(day.id);
    if (working) {
      const next = moveOrder(working.plan, ex.order_id, { defer: true, reason: body.resolution });
      await saveDraft(pool, day.id, next, `Deferred ${ex.order_id} after exception`);
    }
  }
  res.json({ ok: true, needs_publish: body.action === 'defer_order' });
}));

/** Weekly demand history by depot and brand plus a transparent seasonal-naive baseline. */
dispatch.get('/outlook', ah(async (_req, res) => {
  const rows = await q('SELECT * FROM weekly_demand ORDER BY depot, brand, iso_year, iso_week');
  const series: Record<string, any[]> = {};
  for (const r of rows) (series[`${r.depot}|${r.brand}`] ??= []).push(r);
  const out = Object.entries(series).map(([key, s]) => {
    const [depot, brand] = key.split('|');
    const last = s[s.length - 1];
    const recent = s.slice(-8);
    const lastYear = (w: number) => s.find((x) => x.iso_year === last.iso_year - 1 && x.iso_week === w);
    const ratio = (() => {
      const pairs = recent.map((x) => [x, s.find((y) => y.iso_year === x.iso_year - 1 && y.iso_week === x.iso_week)]).filter(([, y]) => y);
      const a = pairs.reduce((t, [x]) => t + x.total_volume_m3, 0);
      const b = pairs.reduce((t, [, y]) => t + y.total_volume_m3, 0);
      return b > 0 ? a / b : 1;
    })();
    const forecast = Array.from({ length: 10 }, (_, i) => {
      const week = 14 + i;
      const ly = lastYear(week);
      const base = ly ? ly.total_volume_m3 * ratio : recent.reduce((t, x) => t + x.total_volume_m3, 0) / recent.length;
      const chilledShare = ly && ly.total_volume_m3 > 0 ? ly.chilled_volume_m3 / ly.total_volume_m3 : 0;
      return { iso_year: 2026, iso_week: week, total_volume_m3: Math.round(base * 10) / 10, chilled_volume_m3: brand === 'Fresh' ? Math.round(base * chilledShare * 10) / 10 : 0 };
    });
    return { depot, brand, history: s.slice(-16), forecast, method: `Seasonal naive: same ISO week last year × recent year-on-year ratio (${ratio.toFixed(2)}). Baseline until the Datathon model is integrated.` };
  });
  const fleet = await q(`SELECT depot, temp, count(*)::int AS vehicles, sum(volume_cap_m3)::float AS volume_per_trip FROM vehicles GROUP BY depot, temp ORDER BY depot, temp`);
  res.json({ series: out, fleet });
}));

/** Restores the seeded demo day so each judge can walk through from the start. */
dispatch.post('/reset', ah(async (_req, res) => {
  await tx(async (c) => { await seedDemoDay(c); });
  res.json({ ok: true });
}));
