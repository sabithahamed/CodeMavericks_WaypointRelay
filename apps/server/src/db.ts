import pg from 'pg';

// numeric columns come back as strings by default; parse them for arithmetic.
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v); // keep dates as YYYY-MM-DD

const url = process.env.DATABASE_URL ?? 'postgres://relay:relay@localhost:5432/relay';
export const pool = new pg.Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
export const one = async <T = any>(text: string, params: unknown[] = []): Promise<T | undefined> => (await q<T>(text, params))[0];

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
