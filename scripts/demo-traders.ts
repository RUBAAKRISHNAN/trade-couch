/**
 * npm run demo:traders [-- --minutes 10]
 *
 * Makes the demo competitors (Priya, Arjun, …) trade in the demo competition while the app is running
 * (`npm run dev`). Every order goes through the real path: pre-trade risk → engine → settlement →
 * Trade Coach → leaderboard. Each trader has a fixed "discipline" level: disciplined traders size small,
 * plan a stop and target, and protect positions with a stop order; impulsive ones size big and don't.
 */
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import { config, createPool } from '@tradecore/shared/node';
import { placeOrder, RedisCommandBus, requestCancel } from '../apps/api/src/index';
import { DEMO_COMPETITION_SLUG, DEMO_TRADERS, demoTraderEmail } from '../db/seed/demo';

const { values } = parseArgs({ options: { minutes: { type: 'string', default: '10' } } });
const until = Date.now() + Number(values.minutes) * 60_000;

const pool = createPool(undefined, 4);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const bus = new RedisCommandBus(redis);

const comp = (
  await pool.query<{ id: number }>(
    `SELECT id FROM competitions WHERE slug = $1 AND now() BETWEEN starts_at AND ends_at`,
    [DEMO_COMPETITION_SLUG],
  )
).rows[0];
if (!comp) {
  console.error('The demo competition is not live. Run `npm run db:seed` first.');
  process.exit(1);
}

const traders = (
  await pool.query<{ account_id: number; name: string }>(
    `SELECT a.id AS account_id, u.display_name AS name FROM accounts a JOIN users u ON u.id = a.user_id
     WHERE a.competition_id = $1 AND u.email = ANY($2::text[]) ORDER BY u.display_name`,
    [comp.id, DEMO_TRADERS.map(demoTraderEmail)],
  )
).rows.map((t, i) => ({ ...t, discipline: [0.95, 0.3, 0.8, 0.15, 0.65, 0.5, 0.9, 0.35][i % 8]! }));

const instruments = (
  await pool.query<{ symbol: string; qty_scale: number; lot_size_units: number; tick_size_paise: number }>(
    `SELECT i.symbol, i.qty_scale, i.lot_size_units, i.tick_size_paise FROM instruments i
     JOIN market_prices mp ON mp.symbol = i.symbol WHERE i.status = 'ACTIVE' AND mp.ref_price_paise IS NOT NULL`,
  )
).rows;
if (!instruments.length) {
  console.error('No live prices yet — start the app (`npm run dev`) and wait a few seconds.');
  process.exit(1);
}
console.log(`${traders.length} demo traders, ${instruments.length} instruments, for ${values.minutes} min…`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const toTick = (v: number, t: number) => Math.max(t, Math.round(v / t) * t);
let placed = 0;
let rejected = 0;

while (Date.now() < until) {
  const t = pick(traders);
  const inst = pick(instruments);
  try {
    const ref = (
      await pool.query<{ p: number }>('SELECT ref_price_paise AS p FROM market_prices WHERE symbol = $1', [
        inst.symbol,
      ])
    ).rows[0]!.p;
    const h = (
      await pool.query<{ free: number }>(
        `SELECT qty_units - qty_held_units AS free FROM holdings WHERE account_id = $1 AND symbol = $2`,
        [t.account_id, inst.symbol],
      )
    ).rows[0];
    const open = await pool.query<{ id: number }>(
      `SELECT id FROM orders WHERE account_id = $1 AND symbol = $2 AND status IN ('OPEN', 'PARTIALLY_FILLED')`,
      [t.account_id, inst.symbol],
    );
    const held = (
      await pool.query<{ q: number }>(
        'SELECT qty_units AS q FROM holdings WHERE account_id = $1 AND symbol = $2',
        [t.account_id, inst.symbol],
      )
    ).rows[0]?.q;

    if (held && Math.random() < 0.55) {
      // close the whole position: cancel its protective stop first so the units are free
      for (const o of open.rows) await requestCancel(pool, bus, [t.account_id], o.id);
      if (open.rowCount) await sleep(400);
      const free = (
        await pool.query<{ free: number }>(
          `SELECT qty_units - qty_held_units AS free FROM holdings WHERE account_id = $1 AND symbol = $2`,
          [t.account_id, inst.symbol],
        )
      ).rows[0]?.free;
      if (free && free > 0) {
        await placeOrder(pool, bus, t.account_id, {
          symbol: inst.symbol,
          side: 'SELL',
          type: 'MARKET',
          tif: 'IOC',
          qty: free,
        });
        placed++;
      }
    } else if (!h || h.free === 0) {
      const cash = (
        await pool.query<{ free: number }>(
          'SELECT cash_paise - cash_held_paise AS free FROM accounts WHERE id = $1',
          [t.account_id],
        )
      ).rows[0]!.free;
      const disciplined = Math.random() < t.discipline;
      const sizePct = disciplined ? 2 + Math.random() * 4 : 10 + Math.random() * 35;
      const budget = Math.min(cash * 0.9, (1_00_000_00 * sizePct) / 100);
      // the market-order hold is sized at the reference price + the 5% band
      const units =
        Math.floor((budget * inst.qty_scale) / (ref * 1.05) / inst.lot_size_units) * inst.lot_size_units;
      if (units >= inst.lot_size_units) {
        const stop = toTick(ref * 0.985, inst.tick_size_paise);
        await placeOrder(pool, bus, t.account_id, {
          symbol: inst.symbol,
          side: 'BUY',
          type: 'MARKET',
          tif: 'IOC',
          qty: units,
          ...(disciplined
            ? { planStopPrice: stop, planTargetPrice: toTick(ref * 1.03, inst.tick_size_paise) }
            : {}),
        });
        placed++;
        if (disciplined) {
          await sleep(500);
          const got = (
            await pool.query<{ free: number }>(
              `SELECT qty_units - qty_held_units AS free FROM holdings WHERE account_id = $1 AND symbol = $2`,
              [t.account_id, inst.symbol],
            )
          ).rows[0]?.free;
          if (got)
            await placeOrder(pool, bus, t.account_id, {
              symbol: inst.symbol,
              side: 'SELL',
              type: 'STOP_MARKET',
              tif: 'IOC',
              qty: got,
              stopPrice: stop,
            });
        }
      }
    }
  } catch (e) {
    rejected++;
    if (rejected % 10 === 1) console.log(`(order refused: ${(e as Error).message})`);
  }
  await sleep(800 + Math.random() * 1500);
}

console.log(`done: ${placed} orders placed, ${rejected} refused`);
await pool.end();
redis.disconnect();
