import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import type { District, Outlet, PlanOrder, PlanningContext, Vehicle } from '../planner/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = process.env.SEED_DIR ?? resolve(here, '../../../../seed/data');

export function readCsv(name: string): Record<string, string>[] {
  return parse(readFileSync(resolve(SEED_DIR, name)), { columns: true, skip_empty_lines: true });
}

const num = (s: string) => Number(s);

export const loadOutlets = (): Outlet[] =>
  readCsv('outlets.csv').map((r) => ({ ...r, mall_window: r.mall_window || null }) as unknown as Outlet);

export const loadVehicles = (): Vehicle[] =>
  readCsv('vehicles.csv').map((r) => ({
    ...(r as any),
    weight_cap_kg: num(r.weight_cap_kg),
    volume_cap_m3: num(r.volume_cap_m3),
    km_per_l: num(r.km_per_l),
    weekly_fuel_quota_l: num(r.weekly_fuel_quota_l),
  }));

export const loadDistricts = (): District[] =>
  readCsv('district_travel.csv').map((r) => ({
    district: r.district,
    depot: r.depot,
    depot_to_district_km: num(r.depot_to_district_km),
    depot_to_district_freeflow_min: num(r.depot_to_district_freeflow_min),
    inter_stop_km: num(r.inter_stop_km),
    inter_stop_freeflow_min: num(r.inter_stop_freeflow_min),
  }));

export const loadAllowance = (): Record<string, number> =>
  Object.fromEntries(readCsv('service_allowance.csv').map((r) => [`${r.brand}|${r.dock_type}`, num(r.service_allowance_min)]));

/** Scenario S1 as a pure planning fixture (used by tests and by the database seed). */
export function loadS1(): { orders: PlanOrder[]; ctx: PlanningContext } {
  const orders: PlanOrder[] = readCsv('task2b_peak_day_scenarios.csv').map((r) => ({
    id: r.order_ref,
    outlet_id: r.outlet_id,
    brand: r.brand as PlanOrder['brand'],
    district: r.district,
    depot: r.depot,
    temp_requirement: r.temp_requirement as PlanOrder['temp_requirement'],
    units: num(r.order_units),
    weight_kg: num(r.order_weight_kg),
    volume_m3: num(r.order_volume_m3),
    dock_type: r.dock_type as PlanOrder['dock_type'],
    parking_constraint: r.parking_constraint as PlanOrder['parking_constraint'],
    window_open: r.window_open_time,
    window_close: r.window_close_time,
    deferred_yesterday: r.deferred_yesterday === '1',
    days_since_last_served: num(r.days_since_last_served),
  }));
  const vehicles = loadVehicles();
  const available = new Set(readCsv('task2b_peak_day_fleet.csv').filter((r) => r.status === 'available').map((r) => r.vehicle_id));
  const ctx: PlanningContext = {
    vehicles: Object.fromEntries(vehicles.map((v) => [v.vehicle_id, v])),
    districts: Object.fromEntries(loadDistricts().map((d) => [d.district, d])),
    allowance: loadAllowance(),
    available,
    fuelRemaining: Object.fromEntries(vehicles.map((v) => [v.vehicle_id, v.weekly_fuel_quota_l])),
  };
  return { orders, ctx };
}
