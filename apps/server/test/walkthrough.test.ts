/**
 * End-to-end walkthrough across all four roles against a real Postgres database.
 * Mirrors the judge walkthrough in the README. Skipped when DATABASE_URL is not set.
 *   DATABASE_URL=postgres://relay:relay@localhost:5432/relay npm test
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool, tx } from '../src/db.js';
import { DEMO_PASSWORD, seedAll, seedDemoDay } from '../src/seed/seed.js';

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('judge walkthrough (API)', () => {
  const app = createApp();
  const tokens: Record<string, string> = {};
  const as = (role: string) => ({
    get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${tokens[role]}`),
    post: (p: string, body?: object) => request(app).post(p).set('Authorization', `Bearer ${tokens[role]}`).send(body ?? {}),
  });

  beforeAll(async () => {
    await seedAll();
    await tx((c) => seedDemoDay(c));
    for (const role of ['dispatcher', 'loader', 'driver', 'store']) {
      const r = await request(app).post('/api/auth/login').send({ email: `${role}@waypoint.test`, password: DEMO_PASSWORD });
      expect(r.status).toBe(200);
      tokens[role] = r.body.token;
    }
  });
  afterAll(() => pool.end());

  it('rejects a wrong password and enforces roles', async () => {
    expect((await request(app).post('/api/auth/login').send({ email: 'store@waypoint.test', password: 'nope' })).status).toBe(401);
    expect((await as('store').get('/api/dispatch/day')).status).toBe(403);
  });

  let newOrder: string;
  it('1. store places an order and gets confirmation before cutoff', async () => {
    const r = await as('store').post('/api/store/orders', { temp_requirement: 'ambient', lines: [{ sku: 'FR-DRY', qty: 4 }] });
    expect(r.status).toBe(201);
    newOrder = r.body.id;
    expect(r.body.delivery_date).toBe('2026-10-05');
  });

  it('2. dispatcher closes orders; later orders go to the following run', async () => {
    expect((await as('dispatcher').post('/api/dispatch/day/close')).status).toBe(200);
    const late = await as('store').post('/api/store/orders', { temp_requirement: 'chilled', lines: [{ sku: 'FR-DAIRY', qty: 2 }] });
    expect(late.status).toBe(201);
    expect(late.body.delivery_date).toBe('2026-10-06');
  });

  it('3. dispatcher builds a feasible plan with explained deferrals', async () => {
    const r = await as('dispatcher').post('/api/dispatch/plan/auto');
    expect(r.status).toBe(200);
    expect(r.body.plan.violations).toEqual([]);
    expect(r.body.plan.deferred.find((d: any) => d.order_id === 'S1-078').code).toBe('exceeds_vehicle_capacity');
    expect(r.body.orders.some((o: any) => o.id === newOrder)).toBe(true);
  });

  it('4. an infeasible manual move is refused with the reason', async () => {
    const r = await as('dispatcher').post('/api/dispatch/plan/move', { order_id: 'S1-001', vehicle_id: 'VEH003', trip_no: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/van-only/);
  });

  it('5. dispatcher publishes; store sees ETA or deferral reason', async () => {
    expect((await as('dispatcher').post('/api/dispatch/plan/publish', { note: 'test' })).status).toBe(200);
    const s = await as('store').get('/api/store/orders');
    const chilled = s.body.orders.find((o: any) => o.id === 'S1-003');
    expect(chilled.assignment.vehicle_id).toBe('VEH036');
    expect(chilled.assignment.eta).toMatch(/^\d\d:\d\d$/);
  });

  let tripNo: number;
  it('6. loader must acknowledge, reports a shortfall, and the run is held', async () => {
    const runs = await as('loader').get('/api/loader/runs');
    const veh036 = runs.body.runs.find((t: any) => t.vehicle_id === 'VEH036' && t.stops === 1) ?? runs.body.runs.find((t: any) => t.vehicle_id === 'VEH036');
    tripNo = veh036.trip_no;
    const detail = await as('loader').get(`/api/loader/runs/VEH036/${tripNo}`);
    const first = detail.body.load_order[0];
    expect((await as('loader').post(`/api/loader/runs/VEH036/${tripNo}/release`)).status).toBe(409); // not acknowledged
    await as('loader').post(`/api/loader/runs/VEH036/${tripNo}/ack`);
    const short = await as('loader').post(`/api/loader/runs/VEH036/${tripNo}/check`, { order_id: first.order_id, loaded_units: first.units - 2, status: 'short', note: '2 crates not picked' });
    expect(short.body.status).toBe('short');
    for (const s of detail.body.load_order.slice(1)) await as('loader').post(`/api/loader/runs/VEH036/${tripNo}/check`, { order_id: s.order_id, loaded_units: s.units, status: 'ok' });
    const blocked = await as('loader').post(`/api/loader/runs/VEH036/${tripNo}/release`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/dispatcher/);
  });

  it('7. dispatcher resolves the shortfall; loader releases', async () => {
    const p = await as('dispatcher').get('/api/dispatch/progress');
    const ex = p.body.exceptions.find((e: any) => e.kind === 'loading_shortfall' && e.status === 'open');
    expect((await as('dispatcher').post(`/api/dispatch/exceptions/${ex.id}/resolve`, { action: 'accept', resolution: 'Send short; top up tomorrow' })).status).toBe(200);
    expect((await as('loader').post(`/api/loader/runs/VEH036/${tripNo}/release`)).status).toBe(200);
  });

  it('8. driver syncs offline records idempotently, and store confirms receipt', async () => {
    const runRes = await as('driver').get('/api/driver/run');
    const trip = runRes.body.trips.find((t: any) => t.trip.trip_no === tripNo);
    const stop = trip.stops[0];
    const v = runRes.body.plan_version;
    const delivery = { kind: 'delivery', client_id: randomUUID(), recorded_at: new Date().toISOString(), trip_no: tripNo, plan_version: v, order_id: stop.order_id, outcome: 'delivered', delivered_units: stop.units, has_photo: true };
    const items = [
      { kind: 'ack', client_id: randomUUID(), recorded_at: new Date().toISOString(), trip_no: tripNo, plan_version: v },
      { kind: 'depart', client_id: randomUUID(), recorded_at: new Date().toISOString(), trip_no: tripNo, plan_version: v },
      delivery,
    ];
    const first = await as('driver').post('/api/driver/sync', { items });
    expect(first.body.results.map((r: any) => r.result)).toEqual(['accepted', 'accepted', 'accepted']);
    const retry = await as('driver').post('/api/driver/sync', { items: [delivery] });
    expect(retry.body.results[0].result).toBe('duplicate');
    const { rows } = await pool.query('SELECT count(*)::int AS n, max(proof_status) AS proof FROM delivery_records WHERE order_id = $1', [stop.order_id]);
    expect(rows[0]).toEqual({ n: 1, proof: 'pending' });
    const proof = await as('driver').post('/api/driver/sync', { items: [{ kind: 'proof', client_id: randomUUID(), recorded_at: new Date().toISOString(), delivery_client_id: delivery.client_id, photo: 'data:image/jpeg;base64,AAAA' }] });
    expect(proof.body.results[0].result).toBe('accepted');

    if (stop.outlet.outlet_id === 'OUT002') {
      const rc = await as('store').post(`/api/store/orders/${stop.order_id}/receipt`, { status: 'confirmed', received_units: stop.units });
      expect(rc.body.status).toBe('confirmed');
    }
  });

  it('9. a record made against an outdated plan is kept and flagged as a conflict', async () => {
    const deferred = (await as('dispatcher').get('/api/dispatch/day')).body.plan.deferred[0].order_id;
    const r = await as('driver').post('/api/driver/sync', { items: [{ kind: 'delivery', client_id: randomUUID(), recorded_at: new Date().toISOString(), trip_no: 1, plan_version: 1, order_id: deferred, outcome: 'delivered', delivered_units: 1, has_photo: false }] });
    expect(r.body.results[0].result).toBe('conflict');
    const p = await as('dispatcher').get('/api/dispatch/progress');
    expect(p.body.exceptions.some((e: any) => e.kind === 'sync_conflict' && e.order_id === deferred)).toBe(true);
  });
});
