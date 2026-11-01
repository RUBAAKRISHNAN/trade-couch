import { beforeEach, describe, expect, it } from 'vitest';
import { notional } from '@tradecore/shared';
import { placeOrder, requestCancel } from '../src/trading/orders';
import { runCoach } from '../src/coach/coach';
import { InProcessExchange, makeUser, resetDb, seedInstrument, testPool } from './harness';

const SYM = 'BTC-INR';
const P = 95_00_000_00; // ₹95 lakh per BTC
const STOP = 93_10_000_00; // −2%
const TARGET = 99_75_000_00; // +5%
const pool = testPool();

async function makeBot(units = 1000) {
  const b = await makeUser({ units: { [SYM]: units } });
  await pool.query(`UPDATE users SET role = 'BOT' WHERE id = $1`, [b.userId]);
  return b;
}

describe('trade coach (Postgres)', () => {
  let ex: InProcessExchange;
  beforeEach(async () => {
    await resetDb();
    await seedInstrument(SYM, P);
    await pool.query(
      `INSERT INTO badges (code, name, description) VALUES ('FIRST_TRIP', 'First round trip', 'x') ON CONFLICT DO NOTHING`,
    );
    ex = new InProcessExchange(pool);
  });

  it('turns a buy → sell into one graded round trip, exactly once', async () => {
    const bot = await makeBot();
    const asha = await makeUser();

    // entry with a plan (stop −2%, target +5% → R:R 2.5) and a protective stop order
    await placeOrder(pool, ex, bot.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 10,
      price: P,
    });
    await placeOrder(pool, ex, asha.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: 10,
      price: P,
      planStopPrice: STOP,
      planTargetPrice: TARGET,
    });
    const stop = await placeOrder(pool, ex, asha.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'STOP_MARKET',
      tif: 'IOC',
      qty: 10,
      stopPrice: STOP,
    });

    // position open, nothing to grade yet
    expect((await runCoach(pool)).roundTrips).toBe(0);
    expect(
      (await pool.query('SELECT qty_units FROM coach_positions WHERE account_id = $1', [asha.accountId]))
        .rows,
    ).toEqual([{ qty_units: 10 }]);

    // exit at the target
    await requestCancel(pool, ex, [asha.accountId], stop.id);
    await pool.query(`UPDATE market_prices SET ref_price_paise = $1`, [TARGET]);
    await placeOrder(pool, ex, bot.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: 10,
      price: TARGET,
    });
    await placeOrder(pool, ex, asha.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 10,
      price: TARGET,
    });

    const run = await runCoach(pool);
    expect(run.roundTrips).toBe(1);

    const trips = (await pool.query('SELECT * FROM round_trips')).rows;
    expect(trips).toHaveLength(1); // the BOT's side is never coached
    const expectedPnl = notional(TARGET, 10, 10_000) - notional(P, 10, 10_000);
    expect(trips[0]).toMatchObject({
      account_id: asha.accountId,
      qty_units: 10,
      entry_avg_paise: P,
      exit_avg_paise: TARGET,
      pnl_paise: expectedPnl,
      plan_stop_paise: STOP,
      plan_target_paise: TARGET,
      had_stop_order: true,
      source: 'live',
    });

    const report = (await pool.query('SELECT * FROM coach_reports')).rows[0];
    expect(report.flags).toEqual(expect.arrayContaining(['STOP_USED', 'GOOD_RR', 'FOLLOWED_PLAN']));
    expect(report.grade).toBe('A');
    expect(report.details.plannedRR).toBe(2.5);

    // re-running is a no-op: the cursor already moved past these trades
    expect((await runCoach(pool)).roundTrips).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM round_trips')).rows[0].n).toBe(1);
    const cursor = (await pool.query('SELECT last_seq FROM coach_cursors WHERE symbol = $1', [SYM])).rows[0];
    const maxSeq = (await pool.query('SELECT max(seq)::bigint AS s FROM trades')).rows[0].s;
    expect(cursor.last_seq).toBe(maxSeq);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM coach_positions WHERE account_id = $1', [
          asha.accountId,
        ])
      ).rows[0].n,
    ).toBe(0);

    // weekly roll-up and badge
    const week = (await pool.query('SELECT * FROM weekly_skill WHERE account_id = $1', [asha.accountId]))
      .rows;
    expect(week).toHaveLength(1);
    expect(week[0]).toMatchObject({ trades: 1 });
    expect(week[0].skill_score).toBeGreaterThanOrEqual(80);
    const badges = (await pool.query('SELECT badge_code FROM user_badges WHERE user_id = $1', [asha.userId]))
      .rows;
    expect(badges).toEqual([{ badge_code: 'FIRST_TRIP' }]);
  });

  it('grades an all-in trade with no stop harshly, even when it wins', async () => {
    const bot = await makeBot();
    const ravi = await makeUser();
    // ~95% of ₹1,00,000 in one go: 100 units × ₹950
    await placeOrder(pool, ex, bot.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 100,
      price: P,
    });
    await placeOrder(pool, ex, ravi.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: 100,
      price: P,
    });
    await pool.query(`UPDATE market_prices SET ref_price_paise = $1`, [TARGET]);
    await placeOrder(pool, ex, bot.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: 100,
      price: TARGET,
    });
    await placeOrder(pool, ex, ravi.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 100,
      price: TARGET,
    });

    await runCoach(pool);
    const r = (
      await pool.query(
        'SELECT r.pnl_paise, c.grade, c.flags FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id',
      )
    ).rows[0];
    expect(r.pnl_paise).toBeGreaterThan(0);
    expect(r.flags).toEqual(expect.arrayContaining(['NO_STOP', 'ALL_IN']));
    expect(r.grade).toBe('F');
  });
});
