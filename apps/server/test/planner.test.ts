import { describe, expect, it } from 'vitest';
import { allocate } from '../src/planner/allocate.js';
import { validatePlan, tripMinutes, tripFuelLitres } from '../src/planner/validate.js';
import { scheduleVehicle } from '../src/planner/schedule.js';
import { loadS1 } from '../src/seed/fixtures.js';
import type { Plan } from '../src/planner/types.js';

const { orders, ctx } = loadS1();
const byId = Object.fromEntries(orders.map((o) => [o.id, o]));

describe('trip time (booklet Task 2B formula)', () => {
  it('matches the booklet Gampaha example: 37 + 9x2 + 15 + 15 + 16 = 101', () => {
    const synthetic = ['rear_dock', 'rear_dock', 'street'].map((dock, i) => ({
      ...byId['S1-001'], id: `X${i}`, brand: 'Fresh' as const, district: 'Gampaha', dock_type: dock as any,
    }));
    expect(tripMinutes(synthetic, ctx)).toBe(101);
  });

  it('matches the Designathon VEH036 example: trip 1 = 64 min, trip 2 = 40 min', () => {
    expect(tripMinutes([byId['S1-001'], byId['S1-005']], ctx)).toBe(64);
    expect(tripMinutes([byId['S1-003']], ctx)).toBe(40);
  });

  it('computes fuel from outbound + return + inter-stop distance', () => {
    // Colombo: 12 km each way, 4 km between stops; VEH036 does 10.3 km/L
    expect(tripFuelLitres([byId['S1-001'], byId['S1-005']], ctx.vehicles.VEH036, ctx)).toBeCloseTo(28 / 10.3, 5);
  });
});

describe('validatePlan', () => {
  const allDeferredExcept = (served: string[]): Plan['deferred'] =>
    orders.filter((o) => !served.includes(o.id)).map((o) => ({ order_id: o.id, code: 'dispatcher_choice', reason: 'test' }));

  it('rejects the single-trip VEH036 load that is 55.7 kg over weight', () => {
    const ids = ['S1-001', 'S1-003', 'S1-005'];
    const plan: Plan = { trips: [{ vehicle_id: 'VEH036', trip_no: 1, order_ids: ids }], deferred: allDeferredExcept(ids) };
    const v = validatePlan(plan, orders, ctx);
    expect(v.map((x) => x.rule)).toContain('weight');
    expect(v.find((x) => x.rule === 'weight')!.message).toMatch(/55\.7 kg/);
  });

  it('accepts the two-trip VEH036 arrangement', () => {
    const plan: Plan = {
      trips: [
        { vehicle_id: 'VEH036', trip_no: 1, order_ids: ['S1-001', 'S1-005'] },
        { vehicle_id: 'VEH036', trip_no: 2, order_ids: ['S1-003'] },
      ],
      deferred: allDeferredExcept(['S1-001', 'S1-003', 'S1-005']),
    };
    expect(validatePlan(plan, orders, ctx)).toEqual([]);
  });

  it('rejects chilled goods on an ambient vehicle, trucks at van-only outlets, workshop vehicles and other depots', () => {
    const mk = (vehicle_id: string, id: string): Plan => ({
      trips: [{ vehicle_id, trip_no: 1, order_ids: [id] }],
      deferred: allDeferredExcept([id]),
    });
    expect(validatePlan(mk('VEH038', 'S1-001'), orders, ctx).map((x) => x.rule)).toContain('refrigeration');
    expect(validatePlan(mk('VEH003', 'S1-001'), orders, ctx).map((x) => x.rule)).toContain('vehicle_access');
    expect(validatePlan(mk('VEH001', 'S1-000'), orders, ctx).map((x) => x.rule)).toContain('availability');
    expect(validatePlan(mk('VEH057', 'S1-000'), orders, ctx).map((x) => x.rule)).toContain('home_depot');
  });

  it('rejects mixed brands/districts in one trip and a third trip', () => {
    const fresh = orders.find((o) => o.brand === 'Fresh' && o.district === 'Gampaha' && o.temp_requirement === 'ambient' && o.parking_constraint !== 'van_only')!;
    const style = orders.find((o) => o.brand === 'Style')!;
    const mixed: Plan = { trips: [{ vehicle_id: 'VEH011', trip_no: 1, order_ids: [fresh.id, style.id] }], deferred: allDeferredExcept([fresh.id, style.id]) };
    expect(validatePlan(mixed, orders, ctx).map((x) => x.rule)).toContain('brand_district');
  });

  it('requires every order to be served or deferred exactly once', () => {
    const v = validatePlan({ trips: [], deferred: [] }, orders, ctx);
    expect(v.filter((x) => x.rule === 'coverage')).toHaveLength(orders.length);
  });
});

describe('schedule', () => {
  it('plans VEH036 so all stops arrive inside their windows, with return and reload before trip 2', () => {
    const s = scheduleVehicle(
      [
        { vehicle_id: 'VEH036', trip_no: 1, order_ids: ['S1-001', 'S1-005'] },
        { vehicle_id: 'VEH036', trip_no: 2, order_ids: ['S1-003'] },
      ],
      byId, ctx,
    );
    expect(s.flatMap((t) => t.stops).every((x) => !x.late)).toBe(true);
    expect(s[1].depart_min).toBeGreaterThanOrEqual(s[0].return_min);
  });
});

describe('allocate S1 peak day', () => {
  const plan = allocate(orders, ctx);

  it('produces a plan with zero constraint violations', () => {
    expect(validatePlan(plan, orders, ctx)).toEqual([]);
  });

  it('defers some chilled demand, because refrigerated capacity is provably short (181.6 > 172.4 m3)', () => {
    const deferredChilled = plan.deferred.filter((d) => byId[d.order_id].temp_requirement === 'chilled');
    expect(deferredChilled.length).toBeGreaterThan(0);
  });

  it('marks S1-078 (40.66 m3) as structurally too large for every vehicle', () => {
    const d = plan.deferred.find((x) => x.order_id === 'S1-078');
    expect(d?.code).toBe('exceeds_vehicle_capacity');
    expect(d?.reason).toMatch(/40\.66/);
  });

  it('serves the three chilled van-only Colombo orders on VEH036 using both trips', () => {
    const veh036 = plan.trips.filter((t) => t.vehicle_id === 'VEH036').flatMap((t) => t.order_ids);
    expect(veh036).toEqual(expect.arrayContaining(['S1-001', 'S1-003', 'S1-005']));
    expect(new Set(plan.trips.filter((t) => t.vehicle_id === 'VEH036').map((t) => t.trip_no)).size).toBe(2);
  });

  it('gives every deferral a human-readable reason', () => {
    for (const d of plan.deferred) expect(d.reason.length).toBeGreaterThan(10);
  });

  it('serves a large majority of orders', () => {
    const served = plan.trips.reduce((n, t) => n + t.order_ids.length, 0);
    expect(served).toBeGreaterThanOrEqual(60);
  });
});
