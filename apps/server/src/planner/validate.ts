import { scheduleVehicle } from './schedule.js';
import { DAYTIME_BUDGET_MIN, FRESH_BUDGET_MIN, MAX_TRIPS, toHHMM } from './time.js';
import type { Plan, PlanOrder, PlanningContext, Trip, Vehicle, Violation } from './types.js';

const EPS = 1e-6;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Booklet Task 2B planning duration: outbound + inter-stop travel + handling (no return leg). */
export function tripMinutes(orders: PlanOrder[], ctx: PlanningContext): number {
  if (orders.length === 0) return 0;
  const d = ctx.districts[orders[0].district];
  return (
    d.depot_to_district_freeflow_min +
    (orders.length - 1) * d.inter_stop_freeflow_min +
    orders.reduce((s, o) => s + ctx.allowance[`${o.brand}|${o.dock_type}`], 0)
  );
}

/** Fuel for a round trip: out and back plus typical distance between stops. */
export function tripFuelLitres(orders: PlanOrder[], v: Vehicle, ctx: PlanningContext): number {
  if (orders.length === 0) return 0;
  const d = ctx.districts[orders[0].district];
  return (2 * d.depot_to_district_km + (orders.length - 1) * d.inter_stop_km) / v.km_per_l;
}

/**
 * Checks one vehicle's trips against every per-vehicle rule. Shared by the full-plan
 * validator and the allocator, so an allocation is only accepted if it would validate.
 */
export function vehicleViolations(vehicleId: string, trips: Trip[], byId: Record<string, PlanOrder>, ctx: PlanningContext): Violation[] {
  const out: Violation[] = [];
  const v = ctx.vehicles[vehicleId];
  if (!v) return [{ rule: 'unknown_vehicle', message: `Unknown vehicle ${vehicleId}`, vehicle_id: vehicleId }];
  if (!ctx.available.has(vehicleId)) {
    out.push({ rule: 'availability', message: `${vehicleId} is not available on this day (workshop).`, vehicle_id: vehicleId });
  }
  if (trips.length > MAX_TRIPS) {
    out.push({ rule: 'trip_limit', message: `${vehicleId} has ${trips.length} trips; a vehicle can run at most ${MAX_TRIPS} a day.`, vehicle_id: vehicleId });
  }
  const nos = trips.map((t) => t.trip_no);
  if (new Set(nos).size !== nos.length || nos.some((n) => n !== 1 && n !== 2)) {
    out.push({ rule: 'trip_limit', message: `${vehicleId} trip numbers must be 1 and 2 and not repeat.`, vehicle_id: vehicleId });
  }

  let fresh = 0;
  let daytime = 0;
  let fuel = 0;
  for (const t of trips) {
    const tag = { vehicle_id: vehicleId, trip_no: t.trip_no };
    const os = t.order_ids.map((id) => byId[id]);
    if (os.length === 0) continue;
    for (const o of os) {
      if (o.depot !== v.depot) out.push({ rule: 'home_depot', message: `${o.id} belongs to ${o.depot}; ${vehicleId} is based at ${v.depot}.`, ...tag, order_id: o.id });
      if (o.temp_requirement === 'chilled' && v.temp !== 'reefer') out.push({ rule: 'refrigeration', message: `${o.id} is chilled; ${vehicleId} is not refrigerated.`, ...tag, order_id: o.id });
      if (o.parking_constraint === 'van_only' && v.type !== 'van') out.push({ rule: 'vehicle_access', message: `${o.outlet_id} is van-only; ${vehicleId} is a ${v.type}.`, ...tag, order_id: o.id });
    }
    if (new Set(os.map((o) => `${o.brand}|${o.district}`)).size > 1) {
      out.push({ rule: 'brand_district', message: `Trip ${t.trip_no} on ${vehicleId} mixes brands or districts; one brand and district per trip.`, ...tag });
      continue;
    }
    const kg = os.reduce((s, o) => s + o.weight_kg, 0);
    const m3 = os.reduce((s, o) => s + o.volume_m3, 0);
    if (kg > v.weight_cap_kg + EPS) out.push({ rule: 'weight', message: `Trip ${t.trip_no} on ${vehicleId} weighs ${r1(kg)} kg, ${r1(kg - v.weight_cap_kg)} kg over its ${v.weight_cap_kg} kg limit.`, ...tag });
    if (m3 > v.volume_cap_m3 + EPS) out.push({ rule: 'volume', message: `Trip ${t.trip_no} on ${vehicleId} needs ${m3.toFixed(2)} m³, ${(m3 - v.volume_cap_m3).toFixed(2)} m³ over its ${v.volume_cap_m3} m³ limit.`, ...tag });
    const mins = tripMinutes(os, ctx);
    if (os[0].brand === 'Fresh') fresh += mins;
    else daytime += mins;
    fuel += tripFuelLitres(os, v, ctx);
  }
  if (fresh > FRESH_BUDGET_MIN + EPS) out.push({ rule: 'time_budget', message: `${vehicleId} Fresh trips take ${fresh} min; the pre-dawn budget is ${FRESH_BUDGET_MIN} min.`, vehicle_id: vehicleId });
  if (daytime > DAYTIME_BUDGET_MIN + EPS) out.push({ rule: 'time_budget', message: `${vehicleId} Style/Tech trips take ${daytime} min; the daytime budget is ${DAYTIME_BUDGET_MIN} min.`, vehicle_id: vehicleId });
  const remaining = ctx.fuelRemaining[vehicleId] ?? v.weekly_fuel_quota_l;
  if (fuel > remaining + EPS) out.push({ rule: 'fuel', message: `${vehicleId} needs ${r1(fuel)} L; only ${r1(remaining)} L remain in its weekly quota.`, vehicle_id: vehicleId });

  // Fresh must run before Style/Tech on the same vehicle (pre-dawn window first).
  const sorted = [...trips].sort((a, b) => a.trip_no - b.trip_no);
  if (sorted.length === 2 && byId[sorted[1].order_ids[0]]?.brand === 'Fresh' && byId[sorted[0].order_ids[0]]?.brand !== 'Fresh') {
    out.push({ rule: 'trip_order', message: `${vehicleId} must run its Fresh trip as trip 1 (pre-dawn).`, vehicle_id: vehicleId });
  }
  if (out.length === 0) {
    for (const s of scheduleVehicle(trips, byId, ctx)) {
      for (const st of s.stops) {
        if (st.late) out.push({ rule: 'delivery_window', message: `${st.order_id} would arrive at ${toHHMM(st.arrival_min)}, after ${st.outlet_id}'s window closes at ${toHHMM(st.window_close_min)}.`, vehicle_id: vehicleId, trip_no: s.trip_no, order_id: st.order_id });
      }
    }
  }
  return out;
}

export function validatePlan(plan: Plan, orders: PlanOrder[], ctx: PlanningContext): Violation[] {
  const out: Violation[] = [];
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const seen = new Map<string, number>();
  for (const t of plan.trips) for (const id of t.order_ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const d of plan.deferred) seen.set(d.order_id, (seen.get(d.order_id) ?? 0) + 1);
  for (const o of orders) {
    const n = seen.get(o.id) ?? 0;
    if (n !== 1) out.push({ rule: 'coverage', message: n === 0 ? `${o.id} has no decision.` : `${o.id} appears ${n} times.`, order_id: o.id });
  }
  for (const id of seen.keys()) if (!byId[id]) out.push({ rule: 'coverage', message: `${id} is not an order on this day.`, order_id: id });
  for (const d of plan.deferred) if (!d.reason?.trim()) out.push({ rule: 'deferral_reason', message: `${d.order_id} is deferred without a reason.`, order_id: d.order_id });

  const byVehicle = new Map<string, Trip[]>();
  for (const t of plan.trips) byVehicle.set(t.vehicle_id, [...(byVehicle.get(t.vehicle_id) ?? []), t]);
  for (const [vid, trips] of byVehicle) out.push(...vehicleViolations(vid, trips.filter((t) => t.order_ids.every((id) => byId[id])), byId, ctx));
  return out;
}
