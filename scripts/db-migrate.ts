/**
 * Minimal forward-only migration runner. Applies db/migrations/*.sql in name order, each in its own
 * transaction, and records it in schema_migrations. Raw SQL is the source of truth for the schema
 * (partitions, triggers, CHECKs, BRIN, materialized views); Prisma only reads it.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { pgConfig } from '@tradecore/shared/node';

const dir = path.resolve(import.meta.dirname, '../db/migrations');
const database = process.env.DB_NAME ?? 'tradecore';
const client = new pg.Client(pgConfig(database));
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const done = new Set(
  (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
);
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
let applied = 0;
for (const f of files) {
  if (done.has(f)) continue;
  const sql = await readFile(path.join(dir, f), 'utf8');
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    await client.query('COMMIT');
    console.log(`+ ${database}: applied ${f}`);
    applied++;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`✗ ${database}: failed ${f}`);
    throw e;
  }
}
if (!applied) console.log(`✓ ${database}: up to date (${files.length} migrations)`);
await client.end();
