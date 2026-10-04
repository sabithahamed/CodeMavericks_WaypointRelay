import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { pool, tx } from '../db.js';
import { SEED_DIR, loadDistricts, loadOutlets, readCsv } from './fixtures.js';

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

/** Files from the competition dataset that must be copied into seed/data (see seed/data/README.md). */
export const REQUIRED_FILES = ['outlets.csv', 'vehicles.csv', 'district_travel.csv', 'service_allowance.csv', 'task2b_peak_day_scenarios.csv', 'task2b_peak_day_fleet.csv'];
/** Optional: order history for the capacity outlook. */
export const OPTIONAL_FILES = ['calendar.csv', 'deliveries_train.csv', 'task1_test_inputs.csv'];

function assertSeedFiles() {
  const missing = REQUIRED_FILES.filter((f) => !existsSync(resolve(SEED_DIR, f)));
  if (missing.length) {
    throw new Error(
      `Seed data missing from ${SEED_DIR}: ${missing.join(', ')}.
` +
        'The competition datasets are not redistributed in this repository. Copy them from the Tech-Triathlon dataset folder into seed/data/ (see seed/data/README.md), then start again.',
    );
  }
}

async function seedReference(c: pg.PoolClient) {
  const { rows } = await c.query('SELECT count(*)::int AS n FROM outlets');
  if (rows[0].n > 0) return;
  assertSeedFiles();
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
  for (const r of readCsv('task2b_peak_day_scenarios.csv')) {
    await c.query('INSERT INTO scenario_orders VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [r.order_ref, r.outlet_id, r.temp_requirement, r.order_units, r.order_weight_kg, r.order_volume_m3, r.deferred_yesterday === '1', r.days_since_last_served]);
  }
  for (const r of readCsv('task2b_peak_day_fleet.csv')) {
    await c.query('INSERT INTO scenario_fleet VALUES ($1,$2)', [r.vehicle_id, r.status]);
  }
  await seedWeeklyDemand(c);
}

/**
 * Weekly requested demand by depot and brand, from the order history if it was supplied.
 * Every order counts once in the ISO week it was requested, including deferred and never-run ones.
 */
async function seedWeeklyDemand(c: pg.PoolClient) {
  if (!OPTIONAL_FILES.every((f) => existsSync(resolve(SEED_DIR, f)))) {
    console.log('Order history not supplied; the capacity outlook will be empty.');
    return;
  }
  const week = new Map(readCsv('calendar.csv').map((r) => [r.date, [Number(r.iso_year), Number(r.iso_week)] as const]));
  const agg = new Map<string, { total: number; chilled: number; n: number }>();
  for (const file of ['deliveries_train.csv', 'task1_test_inputs.csv']) {
    for (const r of readCsv(file)) {
      const w = week.get(r.order_date);
      if (!w) continue;
      const key = `${r.depot}|${r.brand}|${w[0]}|${w[1]}`;
      const a = agg.get(key) ?? { total: 0, chilled: 0, n: 0 };
      const v = Number(r.order_volume_m3);
      a.total += v;
      if (r.temp_requirement === 'chilled') a.chilled += v;
      a.n += 1;
      agg.set(key, a);
    }
  }
  for (const [key, a] of agg) {
    const [depot, brand, y, w] = key.split('|');
    await c.query('INSERT INTO weekly_demand VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [depot, brand, Number(y), Number(w), Math.round(a.total * 1000) / 1000, Math.round(a.chilled * 1000) / 1000, a.n]);
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
  const workshop = (await c.query(`SELECT vehicle_id FROM scenario_fleet WHERE status = 'in_workshop' ORDER BY vehicle_id`)).rows.map((r) => r.vehicle_id);
  const { rows } = await c.query('INSERT INTO delivery_days (delivery_date, depot, label, workshop) VALUES ($1,$2,$3,$4) RETURNING id', [DEMO_DAY.date, DEMO_DAY.depot, DEMO_DAY.label, workshop]);
  const dayId = rows[0].id;
  await c.query(
    `INSERT INTO orders (id, day_id, requested_date, outlet_id, temp_requirement, units, weight_kg, volume_m3, deferred_yesterday, days_since_last_served, source)
     SELECT order_ref, $1, $2, outlet_id, temp_requirement, units, weight_kg, volume_m3, deferred_yesterday, days_since_last_served, 'S1' FROM scenario_orders ORDER BY order_ref`,
    [dayId, DEMO_DAY.date],
  );
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
