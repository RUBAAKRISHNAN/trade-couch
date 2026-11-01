/**
 * npm run load:test [-- --users 100 --seconds 60 --symbol BTC-INR]
 *
 * END-TO-END load test against the running app (`npm run dev`): real HTTP → API (auth, validation, risk
 * holds in Postgres) → Redis stream → matching engine → settlement transaction → order status.
 * Reports:
 *  - HTTP: accepted orders/sec and request latency (p50/p95/p99)
 *  - settle: time from order insert (orders.created_at) to its final settled state (orders.updated_at)
 *  - the ledger invariants afterwards
 * Load accounts are created with role BOT so they never appear on leaderboards or in the Trade Coach.
 * Each user is rate-limited by the API (30 orders / 10 s), so more users = more load.
 */
import { parseArgs } from 'node:util';
import { config, createPool, withTx } from '@tradecore/shared/node';
import { checkInvariants, createAccount, grantUnits } from '../apps/api/src/index';
import { signAccess } from '../apps/api/src/lib/auth';

const { values } = parseArgs({
  options: {
    users: { type: 'string', default: '100' },
    seconds: { type: 'string', default: '60' },
    symbol: { type: 'string', default: 'BTC-INR' },
  },
});
const USERS = Number(values.users);
const SECONDS = Number(values.seconds);
const SYM = values.symbol!;
const API = `http://127.0.0.1:${config.apiPort}/api`;

const pool = createPool(undefined, 10);
const found = (
  await pool.query<{
    qty_scale: number;
    lot_size_units: number;
    tick_size_paise: number;
    ref: number | null;
  }>(
    `SELECT i.qty_scale, i.lot_size_units, i.tick_size_paise, mp.ref_price_paise AS ref
     FROM instruments i LEFT JOIN market_prices mp ON mp.symbol = i.symbol WHERE i.symbol = $1 AND i.status = 'ACTIVE'`,
    [SYM],
  )
).rows[0];
if (!found?.ref) {
  console.error(`${SYM} has no live price — start the app with \`npm run dev\` first.`);
  process.exit(1);
}
const inst = { ...found, ref: found.ref };
const health = await fetch(`${API}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`API not reachable at ${API} — start the app with \`npm run dev\` first.`);
  process.exit(1);
}

// ── load users: cash + some units so they can both buy and sell
const runId = Date.now().toString(36);
const users: { id: string; token: string }[] = [];
await withTx(pool, async (c) => {
  for (let i = 0; i < USERS; i++) {
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, 'x', $2, 'BOT') RETURNING id`,
      [`load-${runId}-${i}@load.tradecore.dev`, `Load ${i}`],
    );
    const acct = await createAccount(c, u.rows[0]!.id, null, 10_00_000_00);
    await grantUnits(
      c,
      acct,
      SYM,
      200 * inst.lot_size_units,
      Math.round((inst.ref! * 200 * inst.lot_size_units) / inst.qty_scale),
      'load test',
    );
    users.push({
      id: u.rows[0]!.id,
      token: await signAccess({ sub: u.rows[0]!.id, role: 'BOT', name: `Load ${i}` }),
    });
  }
});
console.log(`run ${runId}: ${USERS} users × ${SECONDS}s on ${SYM} (ref ${inst.ref / 100})…`);

const lat: number[] = [];
const codes = new Map<string, number>();
let accepted = 0;
const started = Date.now();
const until = started + SECONDS * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toTick = (v: number) =>
  Math.max(inst.tick_size_paise, Math.round(v / inst.tick_size_paise) * inst.tick_size_paise);

async function userLoop(u: { token: string }, n: number) {
  await sleep((n * 37) % 1000); // spread the start
  let i = 0;
  while (Date.now() < until) {
    i++;
    const side = (i + n) % 2 ? 'BUY' : 'SELL';
    // 60% market orders (they trade against the market makers), 40% limit orders near the touch
    const body =
      i % 5 < 3
        ? { symbol: SYM, side, type: 'MARKET', tif: 'IOC', qty: inst.lot_size_units }
        : {
            symbol: SYM,
            side,
            type: 'LIMIT',
            tif: 'IOC',
            qty: inst.lot_size_units,
            price: toTick(inst.ref! * (side === 'BUY' ? 1.001 : 0.999)),
          };
    const t = performance.now();
    try {
      const res = await fetch(`${API}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` },
        body: JSON.stringify(body),
      });
      lat.push(performance.now() - t);
      if (res.status === 202) accepted++;
      else {
        const code =
          ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code ??
          String(res.status);
        codes.set(code, (codes.get(code) ?? 0) + 1);
      }
    } catch {
      codes.set('NETWORK', (codes.get('NETWORK') ?? 0) + 1);
    }
    await sleep(340); // stays under the per-user order rate limit (30 / 10 s)
  }
}
await Promise.all(users.map((u, n) => userLoop(u, n)));
const elapsed = (Date.now() - started) / 1000;

// let the engine and settlement drain, then read settle latency from the database
await sleep(3000);
const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
};
const settle = (
  await pool.query<{ n: number; open: number; p50: number; p95: number; p99: number; filled: number }>(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE o.status IN ('PENDING', 'OPEN', 'PARTIALLY_FILLED'))::int AS open,
            count(*) FILTER (WHERE o.filled_units > 0)::int AS filled,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.updated_at - o.created_at) * 1000) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM o.updated_at - o.created_at) * 1000) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM o.updated_at - o.created_at) * 1000) AS p99
     FROM orders o JOIN accounts a ON a.id = o.account_id JOIN users u ON u.id = a.user_id
     WHERE u.email LIKE $1`,
    [`load-${runId}-%`],
  )
).rows[0]!;
const inv = await checkInvariants(pool);

const r = (x: number) => Math.round(x * 10) / 10;
console.log('\n── results ─────────────────────────────');
console.log(`requests        ${lat.length} in ${r(elapsed)} s  →  ${r(lat.length / elapsed)} req/s`);
console.log(`accepted (202)  ${accepted}  →  ${r(accepted / elapsed)} orders/s`);
console.log(
  `HTTP latency    p50 ${r(pctl(lat, 0.5))} ms · p95 ${r(pctl(lat, 0.95))} ms · p99 ${r(pctl(lat, 0.99))} ms`,
);
console.log(
  `settled orders  ${settle.n - settle.open}/${settle.n} final (${settle.filled} with fills), ${settle.open} still open`,
);
console.log(`insert→settled  p50 ${r(settle.p50)} ms · p95 ${r(settle.p95)} ms · p99 ${r(settle.p99)} ms`);
console.log(`refused         ${[...codes].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
console.log(
  `invariants      ${
    inv.ok
      ? 'all hold ✓'
      : 'VIOLATIONS ✗ ' +
        inv.results
          .filter((x) => !x.ok)
          .map((x) => x.name)
          .join(', ')
  }`,
);
await pool.end();
process.exit(inv.ok ? 0 : 1);
