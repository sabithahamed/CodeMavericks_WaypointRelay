import type pg from 'pg';
import { allocate } from '../planner/allocate.js';
import { scheduleVehicle } from '../planner/schedule.js';
import { tripFuelLitres, tripMinutes, validatePlan } from '../planner/validate.js';
import type { Plan, PlanOrder, PlanningContext, Trip, TripSchedule } from '../planner/types.js';
import { HttpError } from '../auth.js';
import { one, q } from '../db.js';

type Db = Pick<pg.PoolClient, 'query'> | pg.Pool;

export async function getDay(dayId: number) {
  const day = await one('SELECT * FROM delivery_days WHERE id = $1', [dayId]);
  if (!day) throw new HttpError(404, 'Delivery day not found.');
  return day;
}

/** The planning day the dispatcher is working on: the most recent day for the depot. */
export async function currentDay(depot = 'Peliyagoda') {
  const day = await one('SELECT * FROM delivery_days WHERE depot = $1 ORDER BY delivery_date ASC LIMIT 1', [depot]);
  if (!day) throw new HttpError(404, 'No delivery day has been seeded.');
  return day;
}

export async function loadPlanningInputs(dayId: number): Promise<{ orders: PlanOrder[]; ctx: PlanningContext; day: any }> {
  const day = await getDay(dayId);
  const rows = await q(
    `SELECT o.*, ot.brand, ot.district, ot.depot, ot.dock_type, ot.parking_constraint, ot.window_open_time, ot.window_close_time
       FROM orders o JOIN outlets ot USING (outlet_id) WHERE o.day_id = $1 ORDER BY o.id`,
    [dayId],
  );
  const orders: PlanOrder[] = rows.map((r) => ({
    id: r.id, outlet_id: r.outlet_id, brand: r.brand, district: r.district, depot: r.depot,
    temp_requirement: r.temp_requirement, units: r.units, weight_kg: r.weight_kg, volume_m3: r.volume_m3,
    dock_type: r.dock_type, parking_constraint: r.parking_constraint, window_open: r.window_open_time, window_close: r.window_close_time,
    deferred_yesterday: r.deferred_yesterday, days_since_last_served: r.days_since_last_served,
  }));
  const vehicles = await q('SELECT * FROM vehicles');
  const districts = await q('SELECT * FROM districts');
  const allowance = await q('SELECT * FROM service_allowance');
  const fuel = await q('SELECT vehicle_id, used_l FROM fuel_ledger');
  const used = Object.fromEntries(fuel.map((f) => [f.vehicle_id, f.used_l]));
  const unavailable = new Set<string>(day.workshop ?? []);
  const ctx: PlanningContext = {
    vehicles: Object.fromEntries(vehicles.map((v) => [v.vehicle_id, v])),
    districts: Object.fromEntries(districts.map((d) => [d.district, d])),
    allowance: Object.fromEntries(allowance.map((a) => [`${a.brand}|${a.dock_type}`, a.service_allowance_min])),
    available: new Set(vehicles.filter((v) => v.depot === day.depot && !unavailable.has(v.vehicle_id)).map((v) => v.vehicle_id)),
    fuelRemaining: Object.fromEntries(vehicles.map((v) => [v.vehicle_id, v.weekly_fuel_quota_l - (used[v.vehicle_id] ?? 0)])),
  };
  return { orders, ctx, day };
}

export async function latestPlan(dayId: number, status?: 'draft' | 'published') {
  return one(
    `SELECT * FROM plans WHERE day_id = $1 ${status ? 'AND status = $2' : ''} ORDER BY version DESC LIMIT 1`,
    status ? [dayId, status] : [dayId],
  );
}

/** Draft = latest version if it is still a draft; otherwise a working copy of the published plan. */
export async function workingPlan(dayId: number): Promise<{ plan: Plan; version: number; status: string } | null> {
  const p = await latestPlan(dayId);
  if (!p) return null;
  return { plan: p.data, version: p.version, status: p.status };
}

export async function saveDraft(db: Db, dayId: number, plan: Plan, note?: string) {
  const latest = (await db.query('SELECT version, status FROM plans WHERE day_id = $1 ORDER BY version DESC LIMIT 1', [dayId])).rows[0];
  if (latest?.status === 'draft') {
    await db.query('UPDATE plans SET data = $1, note = COALESCE($2, note), created_at = now() WHERE day_id = $3 AND version = $4', [plan, note ?? null, dayId, latest.version]);
    return latest.version as number;
  }
  const version = (latest?.version ?? 0) + 1;
  await db.query(`INSERT INTO plans (day_id, version, status, data, note) VALUES ($1,$2,'draft',$3,$4)`, [dayId, version, plan, note ?? null]);
  return version;
}

export function autoPlan(orders: PlanOrder[], ctx: PlanningContext, keepManualDeferrals?: Plan): Plan {
  const pinned = (keepManualDeferrals?.deferred ?? []).filter((d) => d.code === 'dispatcher_choice' && orders.some((o) => o.id === d.order_id));
  return allocate(orders, ctx, pinned);
}

/** Moves one order and returns the new plan; the caller validates before saving. */
export function moveOrder(plan: Plan, orderId: string, target: { vehicle_id: string; trip_no: 1 | 2 } | { defer: true; reason: string }): Plan {
  const trips: Trip[] = plan.trips.map((t) => ({ ...t, order_ids: t.order_ids.filter((id) => id !== orderId) })).filter((t) => t.order_ids.length > 0);
  const deferred = plan.deferred.filter((d) => d.order_id !== orderId);
  if ('defer' in target) {
    deferred.push({ order_id: orderId, code: 'dispatcher_choice', reason: target.reason });
  } else {
    const existing = trips.find((t) => t.vehicle_id === target.vehicle_id && t.trip_no === target.trip_no);
    if (existing) existing.order_ids.push(orderId);
    else trips.push({ vehicle_id: target.vehicle_id, trip_no: target.trip_no, order_ids: [orderId] });
  }
  // Keep trip numbers contiguous (a lone trip 2 becomes trip 1).
  const byVehicle = new Map<string, Trip[]>();
  for (const t of trips) byVehicle.set(t.vehicle_id, [...(byVehicle.get(t.vehicle_id) ?? []), t]);
  const renumbered = [...byVehicle.values()].flatMap((ts) => ts.sort((a, b) => a.trip_no - b.trip_no).map((t, i) => ({ ...t, trip_no: (i + 1) as 1 | 2 })));
  return { trips: renumbered, deferred };
}

/** Everything the dispatcher's plan screen needs: orders, trips with loads/times, violations. */
export function describePlan(plan: Plan, orders: PlanOrder[], ctx: PlanningContext) {
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const violations = validatePlan(plan, orders, ctx);
  const schedules: TripSchedule[] = [];
  const byVehicle = new Map<string, Trip[]>();
  for (const t of plan.trips) byVehicle.set(t.vehicle_id, [...(byVehicle.get(t.vehicle_id) ?? []), t]);
  for (const [, ts] of byVehicle) schedules.push(...scheduleVehicle(ts.filter((t) => t.order_ids.every((id) => byId[id])), byId, ctx));
  const trips = plan.trips.map((t) => {
    const os = t.order_ids.map((id) => byId[id]).filter(Boolean);
    const v = ctx.vehicles[t.vehicle_id];
    const sched = schedules.find((s) => s.vehicle_id === t.vehicle_id && s.trip_no === t.trip_no);
    return {
      ...t,
      order_ids: sched ? sched.stops.map((s) => s.order_id) : t.order_ids,
      brand: os[0]?.brand, district: os[0]?.district,
      weight_kg: Math.round(os.reduce((s, o) => s + o.weight_kg, 0) * 10) / 10,
      volume_m3: Math.round(os.reduce((s, o) => s + o.volume_m3, 0) * 1000) / 1000,
      minutes: tripMinutes(os, ctx),
      fuel_l: Math.round(tripFuelLitres(os, v, ctx) * 10) / 10,
      vehicle: v,
      schedule: sched ?? null,
    };
  });
  const served = plan.trips.reduce((n, t) => n + t.order_ids.length, 0);
  const chilledCap = [...ctx.available].map((id) => ctx.vehicles[id]).filter((v) => v.temp === 'reefer').reduce((s, v) => s + 2 * v.volume_cap_m3, 0);
  const chilledDemand = orders.filter((o) => o.temp_requirement === 'chilled').reduce((s, o) => s + o.volume_m3, 0);
  return {
    trips,
    deferred: plan.deferred,
    violations,
    summary: {
      orders: orders.length, served, deferred: plan.deferred.length,
      vehicles_used: byVehicle.size, vehicles_available: ctx.available.size,
      chilled_demand_m3: Math.round(chilledDemand * 1000) / 1000, chilled_capacity_m3: Math.round(chilledCap * 10) / 10,
    },
  };
}

/** Difference between two plan versions, in terms of affected orders. */
export function diffPlans(prev: Plan | null, next: Plan, orders: PlanOrder[]) {
  const where = (p: Plan | null) => {
    const m = new Map<string, string>();
    if (!p) return m;
    for (const t of p.trips) for (const id of t.order_ids) m.set(id, `${t.vehicle_id} · trip ${t.trip_no}`);
    for (const d of p.deferred) m.set(id(d), 'deferred');
    return m;
    function id(d: { order_id: string }) { return d.order_id; }
  };
  const a = where(prev);
  const b = where(next);
  const changes = orders
    .map((o) => ({ order_id: o.id, outlet_id: o.outlet_id, from: a.get(o.id) ?? (prev ? 'unplanned' : 'new'), to: b.get(o.id) ?? 'unplanned' }))
    .filter((c) => c.from !== c.to);
  const repeatDeferrals = next.deferred.filter((d) => orders.find((o) => o.id === d.order_id)?.deferred_yesterday);
  return { changes, repeatDeferrals };
}
