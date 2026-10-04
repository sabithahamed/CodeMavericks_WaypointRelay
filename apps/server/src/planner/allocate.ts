import { vehicleViolations } from './validate.js';
import type { Deferral, Plan, PlanOrder, PlanningContext, Trip, Vehicle } from './types.js';

/**
 * Service priority (higher is planned first). Documented policy:
 *  1. outlets skipped on the previous run, then longest since last served (no repeat starvation);
 *  2. chilled before ambient (perishable, and only refrigerated capacity can carry it);
 *  3. Fresh before Style/Tech (opening-time deadline);
 *  4. orders with fewer compatible vehicles first (scarce capability is used where it is needed).
 */
export function priorityScore(o: PlanOrder, compatibleCount: number): number {
  return (
    (o.deferred_yesterday ? 10_000 : 0) +
    Math.min(o.days_since_last_served, 14) * 300 +
    (o.temp_requirement === 'chilled' ? 2_000 : 0) +
    (o.brand === 'Fresh' ? 1_000 : 0) +
    Math.max(0, 50 - compatibleCount) * 10
  );
}

/** Capability match ignoring time and existing load. */
export function isCompatible(o: PlanOrder, v: Vehicle, ctx: PlanningContext): boolean {
  return (
    ctx.available.has(v.vehicle_id) &&
    v.depot === o.depot &&
    (o.temp_requirement !== 'chilled' || v.temp === 'reefer') &&
    (o.parking_constraint !== 'van_only' || v.type === 'van')
  );
}

/** Penalty for using scarce capability an order does not need. */
function wasteCost(o: PlanOrder, v: Vehicle): number {
  return (v.temp === 'reefer' && o.temp_requirement !== 'chilled' ? 100 : 0) + (v.type === 'van' && o.parking_constraint !== 'van_only' ? 50 : 0);
}

const groupKey = (o: PlanOrder) => `${o.brand}|${o.district}`;

/** Fresh trips first so they fall in the pre-dawn window. */
function renumber(trips: Trip[], byId: Record<string, PlanOrder>): Trip[] {
  const sorted = [...trips].sort((a, b) => {
    const fa = byId[a.order_ids[0]].brand === 'Fresh' ? 0 : 1;
    const fb = byId[b.order_ids[0]].brand === 'Fresh' ? 0 : 1;
    return fa - fb || a.trip_no - b.trip_no;
  });
  return sorted.map((t, i) => ({ ...t, trip_no: (i + 1) as 1 | 2 }));
}

export function allocate(orders: PlanOrder[], ctx: PlanningContext, pinned: Deferral[] = []): Plan {
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const vehicles = Object.values(ctx.vehicles);
  const tripsByVehicle = new Map<string, Trip[]>();
  const deferred: Deferral[] = [...pinned];
  const pinnedIds = new Set(pinned.map((d) => d.order_id));

  const compatible = new Map(orders.map((o) => [o.id, vehicles.filter((v) => isCompatible(o, v, ctx))]));
  const queue = orders
    .filter((o) => !pinnedIds.has(o.id))
    .sort((a, b) => priorityScore(b, compatible.get(b.id)!.length) - priorityScore(a, compatible.get(a.id)!.length) || a.id.localeCompare(b.id));

  const unplacedVolume = new Map<string, number>();
  for (const o of queue) unplacedVolume.set(groupKey(o), (unplacedVolume.get(groupKey(o)) ?? 0) + o.volume_m3);

  const tryPlace = (vid: string, next: Trip[]): boolean => {
    const renum = renumber(next, byId);
    if (vehicleViolations(vid, renum, byId, ctx).length > 0) return false;
    tripsByVehicle.set(vid, renum);
    return true;
  };

  for (const o of queue) {
    const cands = compatible.get(o.id)!;
    unplacedVolume.set(groupKey(o), unplacedVolume.get(groupKey(o))! - o.volume_m3);

    if (cands.length === 0) {
      deferred.push({ order_id: o.id, code: 'no_compatible_vehicle', reason: noCompatibleReason(o, ctx) });
      continue;
    }
    const fitsAny = cands.some((v) => o.volume_m3 <= v.volume_cap_m3 && o.weight_kg <= v.weight_cap_kg);
    if (!fitsAny) {
      const maxVol = Math.max(...cands.map((v) => v.volume_cap_m3));
      const maxKg = Math.max(...cands.map((v) => v.weight_cap_kg));
      deferred.push({
        order_id: o.id,
        code: 'exceeds_vehicle_capacity',
        reason: `Needs order revision: ${o.volume_m3} m³ / ${o.weight_kg} kg exceeds every available compatible vehicle (largest ${maxVol} m³ / ${maxKg} kg). Orders cannot be split, so waiting a day will not fix this.`,
      });
      continue;
    }

    // (a) Join an existing trip of the same brand and district; best fit, least wasted capability.
    const joinOptions: { vid: string; trips: Trip[]; cost: number }[] = [];
    for (const v of cands) {
      const trips = tripsByVehicle.get(v.vehicle_id) ?? [];
      for (const t of trips) {
        if (groupKey(byId[t.order_ids[0]]) !== groupKey(o)) continue;
        const usedM3 = t.order_ids.reduce((s, id) => s + byId[id].volume_m3, 0);
        const spare = v.volume_cap_m3 - usedM3 - o.volume_m3;
        if (spare < 0) continue;
        const next = trips.map((x) => (x === t ? { ...x, order_ids: [...x.order_ids, o.id] } : x));
        joinOptions.push({ vid: v.vehicle_id, trips: next, cost: wasteCost(o, v) * 10 + spare });
      }
    }
    joinOptions.sort((a, b) => a.cost - b.cost);
    if (joinOptions.some((j) => tryPlace(j.vid, j.trips))) continue;

    // (b) Open a new trip. Prefer no wasted capability, then a vehicle sized to the group's remaining demand.
    const remaining = unplacedVolume.get(groupKey(o))! + o.volume_m3;
    const openOptions = cands
      .filter((v) => (tripsByVehicle.get(v.vehicle_id)?.length ?? 0) < 2)
      .map((v) => {
        const sizeCost = v.volume_cap_m3 >= remaining ? v.volume_cap_m3 - remaining : 1000 - v.volume_cap_m3;
        const usedCost = tripsByVehicle.has(v.vehicle_id) ? 5 : 0; // spread first trips before doubling up
        return { v, cost: wasteCost(o, v) * 100 + sizeCost + usedCost };
      })
      .sort((a, b) => a.cost - b.cost || a.v.vehicle_id.localeCompare(b.v.vehicle_id));
    let placed = false;
    for (const { v } of openOptions) {
      const trips = tripsByVehicle.get(v.vehicle_id) ?? [];
      if (tryPlace(v.vehicle_id, [...trips, { vehicle_id: v.vehicle_id, trip_no: (trips.length + 1) as 1 | 2, order_ids: [o.id] }])) {
        placed = true;
        break;
      }
    }
    if (!placed) deferred.push({ order_id: o.id, code: 'capacity_shortage', reason: shortageReason(o, cands, tripsByVehicle) });
  }

  return { trips: [...tripsByVehicle.values()].flat(), deferred };
}

function noCompatibleReason(o: PlanOrder, ctx: PlanningContext): string {
  const need = [o.temp_requirement === 'chilled' ? 'refrigerated' : null, o.parking_constraint === 'van_only' ? 'van' : null].filter(Boolean).join(' ');
  return `No available ${need || ''} vehicle at ${o.depot} today${Object.values(ctx.vehicles).some((v) => v.depot === o.depot && !ctx.available.has(v.vehicle_id)) ? ' (others are in the workshop)' : ''}.`.replace('  ', ' ');
}

function shortageReason(o: PlanOrder, cands: Vehicle[], tripsByVehicle: Map<string, Trip[]>): string {
  const kind = o.temp_requirement === 'chilled' ? 'refrigerated ' : o.parking_constraint === 'van_only' ? 'van ' : '';
  const full = cands.filter((v) => (tripsByVehicle.get(v.vehicle_id)?.length ?? 0) >= 2).length;
  return `No room on any of the ${cands.length} compatible ${kind}vehicles: ${full} already run two trips and the rest lack capacity or time in this window. Higher-priority orders were planned first. Review at the next run.`;
}
