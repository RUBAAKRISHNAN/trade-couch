/**
 * Demo data so the app looks alive on first run. Idempotent and non-destructive.
 *
 *  - 14 days of candle history per instrument: a seeded random price path (with occasional jumps) that
 *    ENDS at today's reference price, so history joins up with live trading.
 *  - 2 weeks of graded Trade Coach history for Asha (disciplined), Rahul (impulsive, improving) and
 *    Meera (mixed). These round trips are marked source = 'seed' and shown as "Demo history": no trades
 *    exist behind them, so the ledger invariants are unaffected. They are graded by the SAME code path
 *    as live trips (recordTrip), with entry/exit prices and pre-entry moves taken from the price path.
 *  - A live demo competition (plus an upcoming one) with demo participants. Its standings come from real
 *    orders: run `npm run demo:traders` while the app is running.
 */
import { INSTRUMENTS, notional, type ClosedTrip } from '@tradecore/shared';
import { withTx, type Pool, type PoolClient } from '@tradecore/shared/node';
import { awardBadges, recordTrip, rollUpWeeks } from '../../apps/api/src/coach/coach';
import { createAccount } from '../../apps/api/src/trading/accounts';

const MIN = 60_000;
const DAYS = 14;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

interface Path {
  symbol: string;
  startMs: number;
  /** price per minute, paise (float); index i = startMs + i minutes */
  p: number[];
  tick: number;
  qtyScale: number;
  lot: number;
}

/** Walks BACKWARDS from today's price so the path ends exactly where live trading starts. */
function makePath(symbol: string, endPrice: number, vol: number, seed: number): Path {
  const spec = INSTRUMENTS.find((i) => i.symbol === symbol)!;
  const r = mulberry32(seed);
  const n = DAYS * 1440;
  const s = vol / Math.sqrt(525_600);
  const jump = spec.kind === 'LIVE_CRYPTO' ? 0.018 : 0.008;
  const p = new Array<number>(n + 1);
  p[n] = endPrice;
  for (let i = n - 1; i >= 0; i--) {
    let step = s * gauss(r);
    if (r() < 0.0015) step += (r() < 0.5 ? -1 : 1) * jump * (0.7 + r()); // rare news-like jumps
    p[i] = p[i + 1]! * Math.exp(-step);
  }
  const startMs = Math.floor(Date.now() / MIN) * MIN - n * MIN;
  return { symbol, startMs, p, tick: spec.tickSizePaise, qtyScale: spec.qtyScale, lot: spec.lotSizeUnits };
}

const toTick = (v: number, tick: number) => Math.max(tick, Math.round(v / tick) * tick);

async function seedCandles(c: PoolClient, path: Path, r: () => number) {
  const exists = await c.query(
    `SELECT 1 FROM candles WHERE symbol = $1 AND bucket_start < now() - interval '2 days' LIMIT 1`,
    [path.symbol],
  );
  if (exists.rowCount) return 0;
  const n = path.p.length - 1;
  const minute = Array.from({ length: n }, (_, i) => {
    const o = toTick(path.p[i]!, path.tick);
    const cl = toTick(path.p[i + 1]!, path.tick);
    const wick = Math.abs(path.p[i + 1]! - path.p[i]!) * (0.3 + r());
    return {
      t: path.startMs + i * MIN,
      o,
      h: toTick(Math.max(o, cl) + wick, path.tick),
      l: Math.max(path.tick, toTick(Math.min(o, cl) - wick, path.tick)),
      c: cl,
      v: path.lot * (1 + Math.floor(r() * 40)),
      n: 1 + Math.floor(r() * 12),
    };
  });
  // keep low/high consistent after tick rounding
  for (const m of minute) {
    m.h = Math.max(m.h, m.o, m.c);
    m.l = Math.min(m.l, m.o, m.c);
  }
  const rows: [string, number, number, number, number, number, number, number][] = [];
  const add = (tf: string, bucketMs: number, sinceMs: number) => {
    const groups = new Map<number, typeof minute>();
    for (const m of minute) {
      if (m.t < sinceMs) continue;
      const b = Math.floor(m.t / bucketMs) * bucketMs;
      (groups.get(b) ?? groups.set(b, []).get(b)!).push(m);
    }
    for (const [b, g] of groups)
      rows.push([
        tf,
        b,
        g[0]!.o,
        Math.max(...g.map((x) => x.h)),
        Math.min(...g.map((x) => x.l)),
        g[g.length - 1]!.c,
        g.reduce((s, x) => s + x.v, 0),
        g.reduce((s, x) => s + x.n, 0),
      ]);
  };
  const now = Date.now();
  add('1m', MIN, now - 24 * 60 * MIN);
  add('5m', 5 * MIN, 0);
  add('1h', 60 * MIN, 0);
  add('1d', 1440 * MIN, 0);
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await c.query(
      `INSERT INTO candles (symbol, timeframe, bucket_start, open_paise, high_paise, low_paise, close_paise, volume_units, trade_count)
       SELECT $1, tf, to_timestamp(b / 1000.0), o, h, l, cl, v, n
       FROM unnest($2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[], $9::int[])
            AS x(tf, b, o, h, l, cl, v, n)
       ON CONFLICT DO NOTHING`,
      [path.symbol, ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => chunk.map((row) => row[k]))],
    );
  }
  return rows.length;
}

// ───────────────────────────── coach history ─────────────────────────────

interface Persona {
  email: string;
  seed: number;
  trips: number;
  /** probability of a planned stop/target and a protective stop order; [week 1, week 2] */
  stop: [number, number];
  /** position size as % of equity: [min, max] per week */
  size: [[number, number], [number, number]];
  fomo: number;
  revenge: number;
  overtradeBurst: boolean;
  holdLosers: boolean;
}

const PERSONAS: Persona[] = [
  {
    email: 'asha@tradecore.dev',
    seed: 11,
    trips: 28,
    stop: [0.75, 0.95],
    size: [
      [3, 8],
      [2, 5],
    ],
    fomo: 0.05,
    revenge: 0,
    overtradeBurst: false,
    holdLosers: false,
  },
  {
    email: 'rahul@tradecore.dev',
    seed: 22,
    trips: 34,
    stop: [0.15, 0.55],
    size: [
      [10, 40],
      [5, 15],
    ],
    fomo: 0.35,
    revenge: 0.6,
    overtradeBurst: true,
    holdLosers: true,
  },
  {
    email: 'meera@tradecore.dev',
    seed: 33,
    trips: 24,
    stop: [0.5, 0.6],
    size: [
      [4, 15],
      [4, 12],
    ],
    fomo: 0.15,
    revenge: 0.2,
    overtradeBurst: false,
    holdLosers: true,
  },
];

const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;

/** SEED_RESET_DEMO=1: remove ONLY generated demo trips (source = 'seed') and the scores/badges derived from them. */
async function resetDemoHistory(pool: Pool) {
  await withTx(pool, async (c) => {
    const accts = (
      await c.query<{ account_id: number }>(
        `SELECT DISTINCT account_id FROM round_trips WHERE source = 'seed'`,
      )
    ).rows.map((r) => r.account_id);
    await c.query(`DELETE FROM round_trips WHERE source = 'seed'`); // coach_reports cascade
    await c.query(`DELETE FROM weekly_skill WHERE account_id = ANY($1::bigint[])`, [accts]);
    await c.query(
      `DELETE FROM user_badges WHERE user_id IN (SELECT user_id FROM accounts WHERE id = ANY($1::bigint[]))`,
      [accts],
    );
  });
}

async function seedCoachHistory(pool: Pool, paths: Map<string, Path>) {
  if (process.env.SEED_RESET_DEMO === '1') await resetDemoHistory(pool);
  let made = 0;
  for (const per of PERSONAS) {
    const acct = (
      await pool.query<{ id: number }>(
        `SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1 AND a.competition_id IS NULL`,
        [per.email],
      )
    ).rows[0];
    if (!acct) continue;
    const done = await pool.query(
      `SELECT 1 FROM round_trips WHERE account_id = $1 AND source = 'seed' LIMIT 1`,
      [acct.id],
    );
    if (done.rowCount) continue;

    const r = mulberry32(per.seed);
    const syms = [...paths.keys()];
    const anyPath = paths.get(syms[0]!)!;
    const n = anyPath.p.length - 1;
    let idx = 60 + Math.floor(r() * 300); // minute index into the paths
    let prev: { loss: boolean; size: number } | null = null;
    let burstLeft = 0;

    await withTx(pool, async (c) => {
      for (let k = 0; k < per.trips && idx < n - 240; k++) {
        const week2 = idx > n / 2;
        let size = (() => {
          const [lo, hi] = per.size[week2 ? 1 : 0];
          return lo + r() * (hi - lo);
        })();
        // revenge: straight after a loss, come back bigger
        const inBurst = burstLeft > 0 || (per.overtradeBurst && !week2 && k === 6);
        const revenge = !inBurst && prev?.loss && r() < per.revenge * (week2 ? 0.4 : 1);
        if (revenge) size = Math.min(60, prev!.size * (1.6 + r()));
        const fomo = !inBurst && !revenge && r() < per.fomo * (week2 ? 0.5 : 1);
        // only instruments where one lot fits the intended size (a ₹25,000 index share is 25% of ₹1 lakh)
        const fits = syms.filter((sym) => {
          const pp = paths.get(sym)!;
          const lotCost = (pp.p[idx]! * pp.lot) / pp.qtyScale;
          return (
            lotCost <= (size / 100) * 1_00_000_00 &&
            (!fomo || INSTRUMENTS.find((i) => i.symbol === sym)?.kind === 'LIVE_CRYPTO')
          );
        });
        const path = paths.get(pick(r, fits.length ? fits : syms))!;
        // FOMO: enter right after the sharpest 15-minute rise in the next half day
        if (fomo) {
          let best = idx;
          for (let j = idx; j < Math.min(n - 240, idx + 720); j++)
            if (path.p[j]! / path.p[j - 15]! > path.p[best]! / path.p[best - 15]!) best = j;
          idx = best;
        }
        const entry = toTick(path.p[idx]!, path.tick);
        const units = Math.max(
          path.lot,
          Math.floor(((size / 100) * 1_00_000_00 * path.qtyScale) / entry / path.lot) * path.lot,
        );
        const planned = r() < per.stop[week2 ? 1 : 0];
        const stopPct = 0.01 + r() * 0.015;
        const planStop = planned ? toTick(entry * (1 - stopPct), path.tick) : null;
        const planTarget = planned ? toTick(entry * (1 + stopPct * (1.5 + r() * 1.5)), path.tick) : null;
        if (per.overtradeBurst && !week2 && k === 6) burstLeft = 9;
        let hold = inBurst ? 2 + Math.floor(r() * 3) : 10 + Math.floor(r() * 180);

        // exit: the plan's stop/target if the path touches it first, otherwise the price after `hold`
        let exitIdx = idx + hold;
        let exit = toTick(path.p[exitIdx]!, path.tick);
        if (planStop && planTarget) {
          for (let j = idx + 1; j <= idx + hold; j++) {
            if (path.p[j]! <= planStop) {
              exitIdx = j;
              exit = planStop;
              break;
            }
            if (path.p[j]! >= planTarget) {
              exitIdx = j;
              exit = planTarget;
              break;
            }
          }
        } else if (!inBurst && per.holdLosers && exit < entry && r() < 0.6) {
          // "it'll come back": a losing position held much longer
          exitIdx = Math.min(n - 1, idx + hold * 4 + 120);
          exit = toTick(path.p[exitIdx]!, path.tick);
        }
        hold = exitIdx - idx;

        const buyNotional = notional(entry, units, path.qtyScale);
        const sellNotional = notional(exit, units, path.qtyScale);
        const trip: ClosedTrip = {
          qty: units,
          buyNotional,
          sellNotional,
          pnl: sellNotional - buyNotional,
          openedAt: new Date(path.startMs + idx * MIN),
          closedAt: new Date(path.startMs + exitIdx * MIN),
          entryOrderIds: [],
          exitOrderIds: [],
        };
        const move = ((path.p[idx]! - path.p[idx - 15]!) / path.p[idx - 15]!) * 100;
        if (
          await recordTrip(c, acct.id, path.symbol, path.qtyScale, trip, 'seed', {
            planStop,
            planTarget,
            hadStopOrder: planned,
            moveBeforeEntryPct: move,
          })
        )
          made++;

        prev = { loss: trip.pnl < 0, size };
        if (burstLeft > 0) burstLeft--;
        // next entry: quickly after a loss when revenge-prone, during a burst, or after a normal gap
        const gap =
          burstLeft > 0
            ? 1
            : prev.loss && r() < per.revenge
              ? 5 + Math.floor(r() * 15)
              : 60 + Math.floor(r() * 600);
        idx = exitIdx + gap;
      }
    });
  }
  return made;
}

// ───────────────────────────── competitions ─────────────────────────────

export const DEMO_TRADERS = ['Priya', 'Arjun', 'Kavya', 'Vikram', 'Divya', 'Karthik', 'Sneha', 'Rohan'];
export const demoTraderEmail = (name: string) => `${name.toLowerCase()}@demo.tradecore.dev`;
export const DEMO_COMPETITION_SLUG = 'diwali-trading-cup-2026';

async function seedCompetitions(pool: Pool, passwordHash: string) {
  return withTx(pool, async (c) => {
    const admin = (await c.query<{ id: string }>(`SELECT id FROM users WHERE email = 'admin@tradecore.dev'`))
      .rows[0];
    const live = await c.query<{ id: number }>(
      `INSERT INTO competitions (name, slug, description, starts_at, ends_at, starting_cash_paise, created_by)
       VALUES ('Diwali Trading Cup 2026', $1,
               'Two weeks, ₹1,00,000 of virtual cash each. Highest return wins — and the Coach shows who traded smart.',
               now() - interval '3 days', now() + interval '11 days', 10000000, $2)
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
      [DEMO_COMPETITION_SLUG, admin?.id ?? null],
    );
    await c.query(
      `INSERT INTO competitions (name, slug, description, starts_at, ends_at, starting_cash_paise, created_by)
       VALUES ('New Year Sprint', 'new-year-sprint-2027', 'A one-week sprint with ₹50,000 each.',
               now() + interval '5 days', now() + interval '12 days', 5000000, $1)
       ON CONFLICT (slug) DO NOTHING`,
      [admin?.id ?? null],
    );
    const compId = live.rows[0]!.id;

    const emails = ['asha@tradecore.dev', 'rahul@tradecore.dev', 'meera@tradecore.dev'];
    for (const name of DEMO_TRADERS) {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [demoTraderEmail(name), passwordHash, name],
      );
      const has = await c.query('SELECT 1 FROM accounts WHERE user_id = $1 AND competition_id IS NULL', [
        u.rows[0]!.id,
      ]);
      if (!has.rowCount) await createAccount(c, u.rows[0]!.id, null);
      emails.push(demoTraderEmail(name));
    }
    let joined = 0;
    for (const email of emails) {
      const u = (await c.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0];
      if (!u) continue;
      const has = await c.query('SELECT 1 FROM accounts WHERE user_id = $1 AND competition_id = $2', [
        u.id,
        compId,
      ]);
      if (has.rowCount) continue;
      await createAccount(c, u.id, compId, 1_00_000_00);
      joined++;
    }
    return { competitionId: compId, joined };
  });
}

export async function seedDemo(pool: Pool, passwordHash: string) {
  const active = (
    await pool.query<{ symbol: string; price: number | null }>(
      `SELECT i.symbol, COALESCE(mp.ref_price_paise, mp.last_price_paise) AS price
       FROM instruments i LEFT JOIN market_prices mp ON mp.symbol = i.symbol WHERE i.status = 'ACTIVE' ORDER BY i.symbol`,
    )
  ).rows;
  const paths = new Map<string, Path>();
  let candles = 0;
  for (const [k, a] of active.entries()) {
    const spec = INSTRUMENTS.find((i) => i.symbol === a.symbol);
    if (!spec) continue;
    const path = makePath(
      a.symbol,
      a.price ?? spec.feed.simStartPaise ?? 1e6,
      spec.feed.simVolatility ?? 0.5,
      1000 + k,
    );
    paths.set(a.symbol, path);
    candles += await withTx(pool, (c) => seedCandles(c, path, mulberry32(2000 + k)));
  }
  const trips = await seedCoachHistory(pool, paths);
  const weeks = await rollUpWeeks(pool, 3);
  const badges = await awardBadges(pool);
  const comp = await seedCompetitions(pool, passwordHash);
  await pool.query('REFRESH MATERIALIZED VIEW mv_portfolio_summary');
  await pool.query('REFRESH MATERIALIZED VIEW mv_leaderboard');
  return { candles, coachTrips: trips, weeks, badges, ...comp };
}
