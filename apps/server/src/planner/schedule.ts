import { DAYTIME_START, FRESH_START, RELOAD_MIN, toMin } from './time.js';
import type { PlanOrder, PlanningContext, StopEta, Trip, TripSchedule } from './types.js';

/** Stops are visited in order of the earliest closing window, so tight windows are met first. */
export function sequenceStops(orders: PlanOrder[]): PlanOrder[] {
  return [...orders].sort(
    (a, b) => toMin(a.window_close) - toMin(b.window_close) || toMin(a.window_open) - toMin(b.window_open) || a.id.localeCompare(b.id),
  );
}

/**
 * Operational timetable for one vehicle's trips (stricter than the Task 2B budget):
 * Fresh trips run first from 03:30; a later trip departs only after the previous trip
 * returns to the depot and reloads. A vehicle that arrives early waits for the window.
 */
export function scheduleVehicle(trips: Trip[], byId: Record<string, PlanOrder>, ctx: PlanningContext): TripSchedule[] {
  const ordered = [...trips].sort((a, b) => a.trip_no - b.trip_no);
  const out: TripSchedule[] = [];
  let available = 0;
  for (const trip of ordered) {
    const stops = sequenceStops(trip.order_ids.map((id) => byId[id]));
    if (stops.length === 0) continue;
    const brand = stops[0].brand;
    const d = ctx.districts[stops[0].district];
    const earliest = brand === 'Fresh' ? FRESH_START : DAYTIME_START;
    // Leave as late as possible without missing the first window opening.
    const idealDepart = toMin(stops[0].window_open) - d.depot_to_district_freeflow_min;
    const depart = Math.max(available, earliest, idealDepart);
    let t = depart + d.depot_to_district_freeflow_min;
    const etas: StopEta[] = [];
    stops.forEach((o, i) => {
      if (i > 0) t += d.inter_stop_freeflow_min;
      const open = toMin(o.window_open);
      const close = toMin(o.window_close);
      const start = Math.max(t, open);
      const end = start + ctx.allowance[`${o.brand}|${o.dock_type}`];
      etas.push({ order_id: o.id, outlet_id: o.outlet_id, arrival_min: t, service_start_min: start, depart_min: end, window_close_min: close, late: t > close });
      t = end;
    });
    const ret = t + d.depot_to_district_freeflow_min;
    out.push({ vehicle_id: trip.vehicle_id, trip_no: trip.trip_no, depart_min: depart, return_min: ret, stops: etas });
    available = ret + RELOAD_MIN;
  }
  return out;
}
