import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { ENGINE_GROUP } from '@tradecore/shared';
import { config } from '@tradecore/shared/node';
import { placeOrder, type CommandBus } from '../src/trading/orders';
import { reapLostOrders } from '../src/trading/reaper';
import { checkInvariants } from '../src/trading/invariants';
import { balances, makeUser, resetDb, seedInstrument, testPool } from './harness';

const SYM = 'BTC-INR';
const P = 71_50_000_00;
const pool = testPool();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
// test-only Redis keys, never the live engine's
const run = Date.now().toString(36);
const cmdKey = `tc:test:cmd:${run}`;
const hbKey = `tc:test:hb:${run}`;
const opts = { commandStream: () => cmdKey, heartbeatKey: hbKey, heartbeatWaitMs: 500, settleWaitMs: 300 };

/** A bus that "dies" before writing to Redis: the order commits but its command is never sent. */
const lostBus: CommandBus = { send: async () => {} };

async function lostOrder(accountId: number, ageMs = 120_000) {
  const o = await placeOrder(pool, lostBus, accountId, {
    symbol: SYM,
    side: 'BUY',
    type: 'LIMIT',
    qty: 10,
    price: P,
  });
  await pool.query(`UPDATE orders SET created_at = now() - make_interval(secs => $2) WHERE id = $1`, [
    o.id,
    ageMs / 1000,
  ]);
  return o;
}

/** Engine state as the reaper sees it: a drained (or not) consumer group and a fresh heartbeat. */
async function engineState(opts2: { drained: boolean; engineSeq: number }) {
  await redis.del(cmdKey);
  await redis.xadd(cmdKey, '*', 'c', '{}');
  await redis.xgroup('CREATE', cmdKey, ENGINE_GROUP, '0');
  if (opts2.drained) {
    const r = (await redis.xreadgroup(
      'GROUP',
      ENGINE_GROUP,
      'engine',
      'COUNT',
      10,
      'STREAMS',
      cmdKey,
      '>',
    )) as [string, [string, string[]][]][] | null;
    const ids = r?.[0]?.[1].map(([id]) => id) ?? [];
    if (ids.length) await redis.xack(cmdKey, ENGINE_GROUP, ...ids);
  }
  await redis.hset(hbKey, SYM, JSON.stringify({ seq: opts2.engineSeq, at: Date.now() + 60_000 }));
}

afterAll(async () => {
  await redis.del(cmdKey, hbKey);
  redis.disconnect();
});

describe('lost-order reaper', () => {
  beforeEach(async () => {
    await resetDb();
    await seedInstrument(SYM, P);
    await pool.query(`INSERT INTO engine_offsets (symbol, last_seq) VALUES ($1, 5)`, [SYM]);
  });

  it('rejects an order whose command never reached the engine and releases its hold', async () => {
    const u = await makeUser();
    const o = await lostOrder(u.accountId);
    expect((await balances(u.accountId)).cash_held_paise).toBeGreaterThan(0);

    await engineState({ drained: true, engineSeq: 5 });
    const res = await reapLostOrders(pool, redis, opts);

    expect(res).toEqual([{ symbol: SYM, candidates: 1, reaped: 1 }]);
    const row = (await pool.query('SELECT status, reason, held_cash_paise FROM orders WHERE id = $1', [o.id]))
      .rows[0];
    expect(row).toEqual({ status: 'REJECTED', reason: 'NOT_DELIVERED', held_cash_paise: 0 });
    expect((await balances(u.accountId)).cash_held_paise).toBe(0);
    const inv = await checkInvariants(pool);
    // the test fakes settlement progress (last_seq 5 with no events), so only the gap check can't hold here
    expect(inv.results.filter((r) => !r.ok).map((r) => r.name)).toEqual(['event-log-gap-free']);
    // running again finds nothing
    expect(await reapLostOrders(pool, redis, opts)).toEqual([]);
  });

  it('refuses while the engine still has unconsumed commands (the order may just be queued)', async () => {
    const u = await makeUser();
    const o = await lostOrder(u.accountId);
    await engineState({ drained: false, engineSeq: 5 });
    expect(await reapLostOrders(pool, redis, opts)).toEqual([
      { symbol: SYM, candidates: 1, reaped: 0, skipped: 'engine-behind' },
    ]);
    expect((await pool.query('SELECT status FROM orders WHERE id = $1', [o.id])).rows[0].status).toBe(
      'PENDING',
    );
  });

  it('refuses while settlement is behind the engine (its events may not be written yet)', async () => {
    const u = await makeUser();
    await lostOrder(u.accountId);
    await engineState({ drained: true, engineSeq: 9 }); // engine at 9, settled only to 5
    expect(await reapLostOrders(pool, redis, opts)).toEqual([
      { symbol: SYM, candidates: 1, reaped: 0, skipped: 'settlement-behind' },
    ]);
  });

  it('refuses without a fresh engine heartbeat, and ignores young orders', async () => {
    const u = await makeUser();
    await lostOrder(u.accountId);
    await engineState({ drained: true, engineSeq: 5 });
    await redis.hset(hbKey, SYM, JSON.stringify({ seq: 5, at: Date.now() - 10_000 })); // stale heartbeat
    expect((await reapLostOrders(pool, redis, opts))[0]?.skipped).toBe('no-heartbeat');

    await resetDb();
    await seedInstrument(SYM, P);
    const v = await makeUser();
    await lostOrder(v.accountId, 5_000); // only 5 s old: the API may still be sending it
    expect(await reapLostOrders(pool, redis, opts)).toEqual([]);
  });
});
