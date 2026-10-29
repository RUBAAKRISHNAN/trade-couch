/**
 * npm run smoke [-- seconds]
 * Starts engine + worker for N seconds, then reports what happened and runs the invariant checker.
 */
import os from 'node:os';
import path from 'node:path';
import { createPool } from '@tradecore/shared/node';
import { checkInvariants } from '../apps/api/src/trading/invariants';
import { killTree, sleep, startApp } from './lib/procs';

const secs = Number(process.argv[2] ?? 30);
const logs = path.join(os.tmpdir(), 'tradecore-smoke');
await import('node:fs').then((fs) => fs.mkdirSync(logs, { recursive: true }));
const pool = createPool();
const before = (await pool.query('SELECT count(*)::int AS n FROM trades')).rows[0].n as number;

const engine = startApp('engine', path.join(logs, 'engine.log'));
await sleep(3000);
const worker = startApp('worker', path.join(logs, 'worker.log'));
const stop = () => {
  killTree(worker);
  killTree(engine);
};
process.on('SIGINT', () => {
  stop();
  process.exit(1);
});
console.log(`running engine + worker for ${secs}s (logs in ${logs})…`);
await sleep(secs * 1000);
stop();
await sleep(1500);

const r = (
  await pool.query(`SELECT (SELECT count(*) FROM trades)::int AS trades,
    (SELECT json_object_agg(status, n) FROM (SELECT status, count(*) n FROM orders GROUP BY status) s) AS orders,
    (SELECT json_agg(json_build_object('symbol', symbol, 'ref', ref_price_paise, 'source', ref_source, 'last', last_price_paise)) FROM market_prices) AS prices,
    (SELECT json_object_agg(symbol, last_seq) FROM engine_offsets WHERE last_seq > 0) AS offsets`)
).rows[0];
console.log({ newTrades: r.trades - before, ...r });
const inv = await checkInvariants(pool);
console.log(inv.ok ? 'invariants: all hold' : inv.results.filter((x) => !x.ok));
await pool.end();
process.exit(inv.ok && r.trades > before ? 0 : 1);
