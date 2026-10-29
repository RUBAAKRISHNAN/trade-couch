import pg from 'pg';
import { pgConfig } from './config';

// BIGINT (int8) comes back from pg as a string by default (it can exceed 2^53).
// All our money/qty values are guarded to stay within Number.MAX_SAFE_INTEGER, so parse to number.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint ${v} exceeds safe integer range`);
  return n;
});

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(database?: string, max = 10): pg.Pool {
  return new pg.Pool({ ...pgConfig(database), max, application_name: 'tradecore' });
}

/** Run fn inside a transaction; commit on success, roll back on error. */
export async function withTx<T>(
  pool: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
  isolation = 'READ COMMITTED',
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
