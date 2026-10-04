import type pg from 'pg';
import type { AuthUser } from '../auth.js';

type Db = Pick<pg.PoolClient, 'query'> | pg.Pool;

/** Appends to the shared activity record that every role reads. */
export async function logEvent(
  db: Db,
  e: { order_id?: string | null; day_id?: number | null; kind: string; user: AuthUser | 'system'; message: string; data?: unknown },
) {
  const role = e.user === 'system' ? 'system' : e.user.role;
  const name = e.user === 'system' ? 'Waypoint Relay' : e.user.name;
  await db.query('INSERT INTO events (order_id, day_id, kind, actor_role, actor_name, message, data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    e.order_id ?? null, e.day_id ?? null, e.kind, role, name, e.message, e.data ?? null,
  ]);
}
