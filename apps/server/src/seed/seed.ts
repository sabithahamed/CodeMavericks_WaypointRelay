import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { pool, tx } from '../db.js';
import { loadDistricts, loadOutlets, loadVehicles, readCsv } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The seeded delivery day: Scenario S1, a Peliyagoda peak day one week before a festival. */
export const DEMO_DAY = { date: '2026-10-05', depot: 'Peliyagoda', label: 'Scenario S1 · festival in one week · 10 vehicles in workshop' };

/**
 * Seeded test accounts, one per role (README lists them for judges).
 * The driver runs VEH036, the only available refrigerated van; the store is OUT002,
 * a van-only Colombo Fresh outlet with both an ambient and a chilled order on the day.
 */
export const DEMO_PASSWORD = 'relay2026';
export const DEMO_USERS = [
  { email: 'dispatcher@waypoint.test', role: 'dispatcher', name: 'Nadeesha Perera', depot: 'Peliyagoda' },
  { email: 'loader@waypoint.test', role: 'loader', name: 'Ruwan Silva', depot: 'Peliyagoda' },
  { email: 'driver@waypoint.test', role: 'driver', name: 'Kasun Fernando', depot: 'Peliyagoda', vehicle_id: 'VEH036' },
  { email: 'store@waypoint.test', role: 'store', name: 'Fathima Rizwan', outlet_id: 'OUT002' },
] as const;

export async function applySchema(c: pg.PoolClient | pg.Pool = pool) {
  await c.query(readFileSync(resolve(here, '../schema.sql'), 'utf8'));
}

async function seedReference(c: pg.PoolClient) {
  const { rows } = await c.query('SELECT count(*)::int AS n FROM outlets');
  if (rows[0].n > 0) return;
  for (const o of loadOutlets()) {
    await c.query('INSERT INTO outlets VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [o.outlet_id, o.brand, o.district, o.depot, o.dock_type, o.parking_constraint, o.mall_window, o.window_open_time, o.window_close_time]);
  }
  for (const v of readCsv('vehicles.csv')) {
    await c.query('INSERT INTO vehicles VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [v.vehicle_id, v.type, v.temp, v.weight_cap_kg, v.volume_cap_m3, v.fuel_type, v.km_per_l, v.weekly_fuel_quota_l, v.depot]);
  }
  const roadClass = Object.fromEntries(readCsv('district_travel.csv').map((r) => [r.district, r.road_class]));
  for (const d of loadDistricts()) {
    await c.query('INSERT INTO districts VALUES ($1,$2,$3,$4,$5,$6,$7)', [d.district, d.depot, roadClass[d.district], d.depot_to_district_km, d.depot_to_district_freeflow_min, d.inter_stop_km, d.inter_stop_freeflow_min]);
  }
  for (const a of readCsv('service_allowance.csv')) {
    await c.query('INSERT INTO service_allowance VALUES ($1,$2,$3)', [a.brand, a.dock_type, a.service_allowance_min]);
  }
  for (const w of readCsv('weekly_demand.csv')) {
    await c.query('INSERT INTO weekly_demand VALUES ($1,$2,$3,$4,$5,$6,$7)', [w.depot, w.brand, w.iso_year, w.iso_week, w.total_volume_m3, w.chilled_volume_m3, w.orders]);
  }
}

async function seedUsers(c: pg.PoolClient) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const u of DEMO_USERS) {
    await c.query(
      `INSERT INTO users (email, password_hash, role, name, depot, outlet_id, vehicle_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (email) DO NOTHING`,
      [u.email, hash, u.role, u.name, (u as any).depot ?? null, (u as any).outlet_id ?? null, (u as any).vehicle_id ?? null],
    );
  }
}

/** (Re)creates the demo delivery day with the S1 orders, wiping operational state. */
export async function seedDemoDay(c: pg.PoolClient) {
  await c.query('TRUNCATE sync_log, events, exceptions, receipts, delivery_records, load_checks, trip_runs, plans, orders, delivery_days, fuel_ledger RESTART IDENTITY CASCADE');
  const workshop = readCsv('task2b_peak_day_fleet.csv').filter((r) => r.status === 'in_workshop').map((r) => r.vehicle_id);
  const { rows } = await c.query('INSERT INTO delivery_days (delivery_date, depot, label, workshop) VALUES ($1,$2,$3,$4) RETURNING id', [DEMO_DAY.date, DEMO_DAY.depot, DEMO_DAY.label, workshop]);
  const dayId = rows[0].id;
  for (const r of readCsv('task2b_peak_day_scenarios.csv')) {
    await c.query(
      `INSERT INTO orders (id, day_id, requested_date, outlet_id, temp_requirement, units, weight_kg, volume_m3, deferred_yesterday, days_since_last_served, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'S1')`,
      [r.order_ref, dayId, DEMO_DAY.date, r.outlet_id, r.temp_requirement, r.order_units, r.order_weight_kg, r.order_volume_m3, r.deferred_yesterday === '1', r.days_since_last_served],
    );
  }
  await c.query(
    `INSERT INTO events (order_id, day_id, kind, actor_role, actor_name, message)
     SELECT id, $1, 'order_confirmed', 'system', 'Seed', 'Order confirmed into the delivery queue (Scenario S1 import).' FROM orders`,
    [dayId],
  );
  // Monday of ISO week 41: no fuel used yet this week.
  await c.query(`INSERT INTO fuel_ledger SELECT vehicle_id, 2026, 41, 0 FROM vehicles`);
  return dayId as number;
}

export async function seedAll() {
  await applySchema();
  await tx(async (c) => {
    await seedReference(c);
    await seedUsers(c);
    const { rows } = await c.query('SELECT count(*)::int AS n FROM delivery_days');
    if (rows[0].n === 0) await seedDemoDay(c);
  });
}
