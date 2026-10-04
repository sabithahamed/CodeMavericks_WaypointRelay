import { Router } from 'express';
import { z } from 'zod';
import { HttpError, requireRole } from '../auth.js';
import { one, q, tx } from '../db.js';
import { logEvent } from '../services/events.js';
import { currentDay } from '../services/planning.js';
import { publishedView } from '../services/published.js';

const ah = (fn: (req: any, res: any) => Promise<unknown>) => (req: any, res: any, next: any) => fn(req, res).catch(next);

/** Stops for one published trip, with the outlet details field staff need. */
async function tripDetail(dayId: number, vehicleId: string, tripNo: number) {
  const pv = await publishedView(dayId);
  const trip = pv?.view.trips.find((t) => t.vehicle_id === vehicleId && t.trip_no === tripNo);
  if (!pv || !trip) throw new HttpError(404, 'This run is not in the published plan.');
  const run = await one('SELECT * FROM trip_runs WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3', [dayId, vehicleId, tripNo]);
  const outlets = Object.fromEntries((await q('SELECT * FROM outlets')).map((o) => [o.outlet_id, o]));
  const statuses = Object.fromEntries((await q('SELECT id, status FROM orders WHERE day_id = $1', [dayId])).map((r) => [r.id, r.status]));
  const stops = trip.order_ids.map((id, i) => {
    const o = pv.orders.find((x) => x.id === id)!;
    return { seq: i + 1, order_id: id, status: statuses[id], outlet: outlets[o.outlet_id], temp_requirement: o.temp_requirement, units: o.units, weight_kg: o.weight_kg, volume_m3: o.volume_m3, eta: pv.byOrder.get(id)?.eta };
  });
  return { day: pv.day, plan_version: pv.version, published_at: pv.published_at, run, trip: { ...trip, vehicle: trip.vehicle, schedule: undefined, depart: pv.byOrder.get(trip.order_ids[0])?.depart }, stops };
}

// ---------------------------------------------------------------- Loader

export const loader = Router();
loader.use(requireRole('loader', 'dispatcher'));

loader.get('/runs', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const pv = await publishedView(day.id);
  const runs = await q('SELECT * FROM trip_runs WHERE day_id = $1', [day.id]);
  const checks = await q('SELECT vehicle_id, trip_no, count(*)::int AS n FROM load_checks WHERE day_id = $1 GROUP BY 1,2', [day.id]);
  const list = (pv?.view.trips ?? []).map((t) => {
    const run = runs.find((r) => r.vehicle_id === t.vehicle_id && r.trip_no === t.trip_no);
    return {
      vehicle_id: t.vehicle_id, trip_no: t.trip_no, brand: t.brand, district: t.district, vehicle: t.vehicle,
      stops: t.order_ids.length, weight_kg: t.weight_kg, volume_m3: t.volume_m3,
      chilled: t.order_ids.some((id) => pv!.orders.find((o) => o.id === id)?.temp_requirement === 'chilled'),
      depart: pv!.byOrder.get(t.order_ids[0])?.depart, status: run?.status ?? 'to_load',
      checked: checks.find((c) => c.vehicle_id === t.vehicle_id && c.trip_no === t.trip_no)?.n ?? 0,
      plan_version: run?.plan_version, loader_ack_version: run?.loader_ack_version,
    };
  }).sort((a, b) => (a.depart ?? '').localeCompare(b.depart ?? ''));
  res.json({ day, published_version: pv?.version ?? null, runs: list });
}));

loader.get('/runs/:vid/:trip', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const d = await tripDetail(day.id, req.params.vid, Number(req.params.trip));
  const checks = await q('SELECT * FROM load_checks WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3', [day.id, req.params.vid, Number(req.params.trip)]);
  const exceptions = await q(`SELECT * FROM exceptions WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3 ORDER BY created_at DESC`, [day.id, req.params.vid, Number(req.params.trip)]);
  // Load the last stop first so the first stop's goods are nearest the door.
  res.json({ ...d, load_order: [...d.stops].reverse(), checks, exceptions });
}));

const CheckBody = z.object({
  order_id: z.string(),
  loaded_units: z.number().int().min(0),
  status: z.enum(['ok', 'short', 'damaged']),
  note: z.string().trim().optional(),
});

loader.post('/runs/:vid/:trip/check', ah(async (req, res) => {
  const body = CheckBody.parse(req.body);
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const vid = req.params.vid;
  const tripNo = Number(req.params.trip);
  const d = await tripDetail(day.id, vid, tripNo);
  const stop = d.stops.find((s) => s.order_id === body.order_id);
  if (!stop) throw new HttpError(404, 'That order is not on this run.');
  if (d.run && ['released', 'en_route', 'completed'].includes(d.run.status)) throw new HttpError(409, 'This run has already been released.');
  if (body.status !== 'ok' && !body.note) throw new HttpError(400, 'Describe what is missing or damaged so the dispatcher can decide.');
  const status = body.status === 'ok' && body.loaded_units < stop.units ? 'short' : body.status;
  await tx(async (c) => {
    await c.query(
      `INSERT INTO load_checks (day_id, vehicle_id, trip_no, order_id, expected_units, loaded_units, status, note, checked_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (day_id, vehicle_id, trip_no, order_id) DO UPDATE SET loaded_units = EXCLUDED.loaded_units, status = EXCLUDED.status, note = EXCLUDED.note, checked_at = now(), checked_by = EXCLUDED.checked_by`,
      [day.id, vid, tripNo, body.order_id, stop.units, body.loaded_units, status, body.note ?? null, req.user.id],
    );
    await c.query(`UPDATE trip_runs SET status = CASE WHEN $4 THEN 'held' ELSE CASE WHEN status = 'to_load' THEN 'loading' ELSE status END END WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3`, [day.id, vid, tripNo, status !== 'ok']);
    if (status !== 'ok') {
      const msg = `Loading ${status === 'damaged' ? 'damage' : 'shortfall'} on ${vid} trip ${tripNo}: ${body.loaded_units} of ${stop.units} units loaded for ${stop.outlet.outlet_id}. ${body.note ?? ''}`.trim();
      await c.query(`INSERT INTO exceptions (day_id, order_id, vehicle_id, trip_no, kind, message, raised_by) VALUES ($1,$2,$3,$4,'loading_shortfall',$5,$6)`, [day.id, body.order_id, vid, tripNo, msg, req.user.id]);
      await logEvent(c, { order_id: body.order_id, day_id: day.id, kind: 'loading_shortfall', user: req.user, message: `${msg} Run held for dispatcher review.` });
    }
  });
  res.json({ ok: true, status });
}));

loader.post('/runs/:vid/:trip/ack', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  await q('UPDATE trip_runs SET loader_ack_version = plan_version WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3', [day.id, req.params.vid, Number(req.params.trip)]);
  res.json({ ok: true });
}));

loader.post('/runs/:vid/:trip/release', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const vid = req.params.vid;
  const tripNo = Number(req.params.trip);
  const d = await tripDetail(day.id, vid, tripNo);
  const checks = await q('SELECT * FROM load_checks WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3', [day.id, vid, tripNo]);
  const open = await q(`SELECT id FROM exceptions WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3 AND status = 'open'`, [day.id, vid, tripNo]);
  const unchecked = d.stops.filter((s) => !checks.some((c) => c.order_id === s.order_id));
  if (d.run?.loader_ack_version !== d.run?.plan_version) throw new HttpError(409, `The loading list changed (plan v${d.plan_version}). Review and acknowledge it before release.`);
  if (unchecked.length) throw new HttpError(409, `${unchecked.length} order(s) not checked yet: ${unchecked.map((s) => s.outlet.outlet_id).join(', ')}.`);
  if (open.length) throw new HttpError(409, 'A shortfall is waiting for the dispatcher. The run stays held until it is resolved.');
  await tx(async (c) => {
    await c.query(`UPDATE trip_runs SET status = 'released', released_at = now() WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3`, [day.id, vid, tripNo]);
    for (const s of d.stops) {
      await c.query(`UPDATE orders SET status = 'loaded' WHERE id = $1 AND status = 'planned'`, [s.order_id]);
      await logEvent(c, { order_id: s.order_id, day_id: day.id, kind: 'loaded', user: req.user, message: `Loaded on ${vid} trip ${tripNo} and released for departure.` });
    }
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Driver

export const driver = Router();
driver.use(requireRole('driver'));

/** Everything the phone needs to work offline for the day. */
driver.get('/run', ah(async (req, res) => {
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const pv = await publishedView(day.id);
  const tripNos = (pv?.view.trips ?? []).filter((t) => t.vehicle_id === req.user.vehicle_id).map((t) => t.trip_no).sort();
  const trips = [];
  for (const n of tripNos) trips.push(await tripDetail(day.id, req.user.vehicle_id!, n));
  const records = await q('SELECT client_id, order_id, outcome, proof_status, recorded_at, received_at FROM delivery_records WHERE vehicle_id = $1', [req.user.vehicle_id]);
  res.json({ day, vehicle_id: req.user.vehicle_id, plan_version: pv?.version ?? null, downloaded_at: new Date().toISOString(), trips, records });
}));

const SyncItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ack'), client_id: z.string().uuid(), recorded_at: z.string(), trip_no: z.number(), plan_version: z.number() }),
  z.object({ kind: z.literal('depart'), client_id: z.string().uuid(), recorded_at: z.string(), trip_no: z.number(), plan_version: z.number() }),
  z.object({
    kind: z.literal('delivery'), client_id: z.string().uuid(), recorded_at: z.string(), trip_no: z.number(), plan_version: z.number(),
    order_id: z.string(), outcome: z.enum(['delivered', 'partial', 'failed']), delivered_units: z.number().int().min(0),
    condition: z.string().optional(), recipient: z.string().optional(), note: z.string().optional(), arrived_at: z.string().optional(), has_photo: z.boolean(),
  }),
  z.object({ kind: z.literal('proof'), client_id: z.string().uuid(), recorded_at: z.string(), delivery_client_id: z.string().uuid(), photo: z.string().max(3_000_000) }),
]);

/**
 * Offline outbox upload. Each item carries a phone-generated id, so a retry after a dropped
 * connection returns 'duplicate' instead of creating a second delivery. Facts recorded against an
 * outdated plan are kept and routed to the dispatcher as a conflict rather than discarded.
 */
driver.post('/sync', ah(async (req, res) => {
  const items = z.array(SyncItem).max(200).parse(req.body.items ?? []);
  const day = await currentDay(req.user.depot ?? 'Peliyagoda');
  const pv = await publishedView(day.id);
  const results: { client_id: string; result: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; message?: string }[] = [];
  for (const it of items) {
    try {
      const r = await tx(async (c) => {
        if (it.kind === 'proof') {
          const u = await c.query(`UPDATE delivery_records SET photo = $1, proof_status = 'uploaded' WHERE client_id = $2 AND proof_status <> 'uploaded' RETURNING order_id`, [it.photo, it.delivery_client_id]);
          if (u.rowCount === 0) {
            const exists = await c.query('SELECT 1 FROM delivery_records WHERE client_id = $1', [it.delivery_client_id]);
            return exists.rowCount ? ({ result: 'duplicate' } as const) : ({ result: 'rejected', message: 'Upload the delivery record first.' } as const);
          }
          await logEvent(c, { order_id: u.rows[0].order_id, day_id: day.id, kind: 'proof_uploaded', user: req.user, message: 'Proof-of-delivery photo uploaded.' });
          return { result: 'accepted' } as const;
        }
        const ins = await c.query('INSERT INTO sync_log (client_id, kind, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [it.client_id, it.kind, req.user.id]);
        if (ins.rowCount === 0) return { result: 'duplicate' } as const;
        if (it.kind === 'ack') {
          await c.query('UPDATE trip_runs SET driver_ack_version = $1 WHERE day_id = $2 AND vehicle_id = $3 AND trip_no = $4', [it.plan_version, day.id, req.user.vehicle_id, it.trip_no]);
          return { result: 'accepted' } as const;
        }
        if (it.kind === 'depart') {
          const run = (await c.query('SELECT status FROM trip_runs WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3', [day.id, req.user.vehicle_id, it.trip_no])).rows[0];
          if (run?.status !== 'released' && run?.status !== 'en_route') return { result: 'rejected', message: 'The loader has not released this run yet.' } as const;
          await c.query(`UPDATE trip_runs SET status = 'en_route' WHERE day_id = $1 AND vehicle_id = $2 AND trip_no = $3`, [day.id, req.user.vehicle_id, it.trip_no]);
          const ids = pv?.view.trips.find((t) => t.vehicle_id === req.user.vehicle_id && t.trip_no === it.trip_no)?.order_ids ?? [];
          for (const id of ids) {
            await c.query(`UPDATE orders SET status = 'en_route' WHERE id = $1 AND status IN ('loaded','planned')`, [id]);
            await logEvent(c, { order_id: id, day_id: day.id, kind: 'departed', user: req.user, message: `${req.user.vehicle_id} left the depot on trip ${it.trip_no}.`, data: { recorded_at: it.recorded_at } });
          }
          return { result: 'accepted' } as const;
        }
        // delivery
        const assigned = pv?.byOrder.get(it.order_id);
        const stale = !assigned || assigned.vehicle_id !== req.user.vehicle_id || assigned.trip_no !== it.trip_no;
        await c.query(
          `INSERT INTO delivery_records (client_id, order_id, vehicle_id, trip_no, outcome, delivered_units, condition, recipient, note, arrived_at, recorded_at, plan_version, proof_status, driver_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [it.client_id, it.order_id, req.user.vehicle_id, it.trip_no, it.outcome, it.delivered_units, it.condition ?? null, it.recipient ?? null, it.note ?? null, it.arrived_at ?? null, it.recorded_at, it.plan_version, it.has_photo ? 'pending' : 'none', req.user.id],
        );
        await c.query(`UPDATE orders SET status = $1 WHERE id = $2 AND status NOT IN ('received','issue')`, [it.outcome, it.order_id]);
        const label = { delivered: 'Delivered', partial: 'Partly delivered', failed: 'Not delivered' }[it.outcome];
        await logEvent(c, { order_id: it.order_id, day_id: day.id, kind: 'delivery_recorded', user: req.user, message: `${label}: ${it.delivered_units} units${it.recipient ? `, received by ${it.recipient}` : ''}${it.note ? `. ${it.note}` : ''}. Recorded on phone at ${new Date(it.recorded_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' })}.`, data: { recorded_at: it.recorded_at, plan_version: it.plan_version } });
        if (it.outcome !== 'delivered') {
          await c.query(`INSERT INTO exceptions (day_id, order_id, vehicle_id, trip_no, kind, message, raised_by) VALUES ($1,$2,$3,$4,'delivery_issue',$5,$6)`, [day.id, it.order_id, req.user.vehicle_id, it.trip_no, `${label} at stop for ${it.order_id}: ${it.note ?? 'no note'}`, req.user.id]);
        }
        if (stale) {
          const msg = `Driver recorded ${it.order_id} against plan v${it.plan_version}, but the current plan (v${pv?.version}) ${assigned ? `assigns it to ${assigned.vehicle_id} trip ${assigned.trip_no}` : 'defers it'}. The delivery record is preserved; decide which instruction stands.`;
          await c.query(`INSERT INTO exceptions (day_id, order_id, vehicle_id, trip_no, kind, message, raised_by) VALUES ($1,$2,$3,$4,'sync_conflict',$5,$6)`, [day.id, it.order_id, req.user.vehicle_id, it.trip_no, msg, req.user.id]);
          await logEvent(c, { order_id: it.order_id, day_id: day.id, kind: 'sync_conflict', user: 'system', message: msg });
          return { result: 'conflict', message: 'Your record is saved. The plan changed after you downloaded it, so the dispatcher will review.' } as const;
        }
        return { result: 'accepted' } as const;
      });
      results.push({ client_id: it.client_id, ...r });
    } catch (e: any) {
      results.push({ client_id: it.client_id, result: 'rejected', message: e.message });
    }
  }
  // Mark the trip complete once every stop has a record.
  await q(`UPDATE trip_runs tr SET status = 'completed' WHERE tr.day_id = $1 AND tr.vehicle_id = $2 AND tr.status = 'en_route'
           AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.day_id = tr.day_id AND o.status IN ('en_route','loaded') AND o.id = ANY($3::text[]))`,
    [day.id, req.user.vehicle_id, (pv?.view.trips ?? []).filter((t) => t.vehicle_id === req.user.vehicle_id).flatMap((t) => t.order_ids)]);
  res.json({ results, server_time: new Date().toISOString() });
}));
