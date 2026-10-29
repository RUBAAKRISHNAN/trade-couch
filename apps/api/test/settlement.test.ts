import { beforeEach, describe, expect, it } from 'vitest';
import { OrderBook } from '@tradecore/engine';
import { getInstrument } from '@tradecore/shared';
import { placeOrder, requestAmend, requestCancel } from '../src/trading/orders';
import { loadEventLog, settleBatch } from '../src/trading/settlement';
import { checkInvariants } from '../src/trading/invariants';
import { balances, InProcessExchange, makeUser, resetDb, seedInstrument, testPool } from './harness';

const SYM = 'BTC-INR';
const P = 95_00_000_00; // ₹95,00,000 per BTC, in paise
const UNIT_COST = P / 10_000; // one unit = 0.0001 BTC → ₹950 = 95_000 paise
const pool = testPool();

async function expectInvariants() {
  const r = await checkInvariants(pool);
  const bad = r.results.filter((x) => !x.ok);
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

describe('settlement (Postgres)', () => {
  let ex: InProcessExchange;
  beforeEach(async () => {
    await resetDb();
    await seedInstrument(SYM, P);
    ex = new InProcessExchange(pool);
  });

  it('settles a trade atomically: cash, units, cost basis, P&L, holds, trade row, audit log', async () => {
    const seller = await makeUser({ units: { [SYM]: 10 } });
    const buyer = await makeUser();
    const sellerBefore = await balances(seller.accountId);

    await placeOrder(pool, ex, seller.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 4,
      price: P,
    });
    expect((await balances(seller.accountId)).qty_held_units).toBe(4); // units reserved

    // buyer bids above the ask: trades at the ask (maker) price and gets price improvement
    await placeOrder(pool, ex, buyer.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: 3,
      price: P + 10_000 * 100,
    });

    const b = await balances(buyer.accountId);
    expect(b.cash_paise).toBe(1_00_000_00 - 3 * UNIT_COST);
    expect(b.cash_held_paise).toBe(0); // the extra reservation from bidding higher was released
    expect(b.qty_units).toBe(3);
    expect(b.cost_basis_paise).toBe(3 * UNIT_COST);

    const s = await balances(seller.accountId);
    expect(s.cash_paise).toBe(1_00_000_00 + 3 * UNIT_COST);
    expect(s.qty_units).toBe(7);
    expect(s.qty_held_units).toBe(1); // 1 unit still offered
    expect(s.realized_pnl_paise).toBe(3 * UNIT_COST - Math.floor((sellerBefore.cost_basis_paise * 3) / 10));

    const t = await pool.query('SELECT * FROM trades');
    expect(t.rowCount).toBe(1);
    expect(t.rows[0]).toMatchObject({ price_paise: P, qty_units: 3, aggressor: 'BUY' });
    const audit = await pool.query(`SELECT * FROM audit_log WHERE table_name = 'accounts' AND op = 'UPDATE'`);
    expect(audit.rowCount).toBe(2); // buyer's and seller's cash changed
    await expectInvariants();
  });

  it('rejects an order the account cannot afford (pre-trade risk)', async () => {
    const u = await makeUser({ cash: 10 * UNIT_COST });
    await expect(
      placeOrder(pool, ex, u.accountId, { symbol: SYM, side: 'BUY', type: 'LIMIT', qty: 11, price: P }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expect(
      placeOrder(pool, ex, u.accountId, { symbol: SYM, side: 'SELL', type: 'LIMIT', qty: 1, price: P }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_QTY',
    });
  });

  it('never lets concurrent orders overspend (row locks serialise the holds)', async () => {
    const u = await makeUser({ cash: 10 * UNIT_COST });
    const attempts = Array.from({ length: 20 }, () =>
      placeOrder(pool, ex, u.accountId, { symbol: SYM, side: 'BUY', type: 'LIMIT', qty: 1, price: P }),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const b = await balances(u.accountId);
    expect(b.cash_held_paise).toBe(10 * UNIT_COST);
    await expectInvariants();
  });

  it('releases the hold when an order is cancelled', async () => {
    const u = await makeUser();
    const o = await placeOrder(pool, ex, u.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: 5,
      price: P,
    });
    expect((await balances(u.accountId)).cash_held_paise).toBe(5 * UNIT_COST);
    await requestCancel(pool, ex, [u.accountId], o.id);
    expect((await balances(u.accountId)).cash_held_paise).toBe(0);
    const row = (await pool.query('SELECT status, reason FROM orders WHERE id = $1', [o.id])).rows[0];
    expect(row).toEqual({ status: 'CANCELLED', reason: 'USER' });
    await expectInvariants();
  });

  it('market buy is held at the protection price and refunds the difference', async () => {
    const seller = await makeUser({ units: { [SYM]: 5 } });
    const buyer = await makeUser();
    await placeOrder(pool, ex, seller.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 5,
      price: P,
    });
    const o = await placeOrder(pool, ex, buyer.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'MARKET',
      qty: 2,
    });
    expect(o.protect_price_paise).toBeGreaterThan(P); // ref + 5% band
    const b = await balances(buyer.accountId);
    expect(b.cash_paise).toBe(1_00_000_00 - 2 * UNIT_COST);
    expect(b.cash_held_paise).toBe(0);
    await expectInvariants();
  });

  it('amend up reserves extra; amend reject/confirm keeps holds exact', async () => {
    const u = await makeUser();
    const o = await placeOrder(pool, ex, u.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: 2,
      price: P - 100 * 10_000,
    });
    await requestAmend(pool, ex, [u.accountId], o.id, { price: P, qty: 3 });
    expect((await balances(u.accountId)).cash_held_paise).toBe(3 * UNIT_COST);
    await requestAmend(pool, ex, [u.accountId], o.id, { qty: 1 });
    expect((await balances(u.accountId)).cash_held_paise).toBe(UNIT_COST);
    await expectInvariants();
  });

  it('settles each event exactly once (redelivery is skipped) and refuses gaps', async () => {
    ex.autoSettle = false;
    const seller = await makeUser({ units: { [SYM]: 2 } });
    const buyer = await makeUser();
    await placeOrder(pool, ex, seller.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 2,
      price: P,
    });
    await placeOrder(pool, ex, buyer.accountId, {
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: 2,
      price: P,
    });
    const log = ex.log.get(SYM)!;
    await expect(settleBatch(pool, SYM, log.slice(1))).rejects.toThrow(/gap/);
    const first = await settleBatch(pool, SYM, log);
    expect(first.applied).toBe(log.length);
    const again = await settleBatch(pool, SYM, log);
    expect(again).toMatchObject({ applied: 0, skipped: log.length });
    expect((await pool.query('SELECT count(*)::int AS n FROM trades')).rows[0].n).toBe(1);
    await expectInvariants();
  });

  it('rebuilds the exact order book from the persisted event log (crash recovery)', async () => {
    const users = await Promise.all([1, 2, 3].map(() => makeUser({ units: { [SYM]: 50 } })));
    let k = 0;
    for (let i = 0; i < 60; i++) {
      const u = users[i % 3]!;
      const side = i % 2 ? 'BUY' : 'SELL';
      const off = ((i * 7) % 11) - 5;
      await placeOrder(pool, ex, u.accountId, {
        symbol: SYM,
        side,
        type: 'LIMIT',
        qty: 1 + (i % 4),
        price: P + off * 10_000,
      }).catch(() => k++);
    }
    const spec = getInstrument(SYM);
    const live = ex.book(SYM);
    const rebuilt = OrderBook.replay(
      {
        symbol: SYM,
        tickSizePaise: spec.tickSizePaise,
        lotSizeUnits: spec.lotSizeUnits,
        priceBandBps: spec.priceBandBps,
      },
      await loadEventLog(pool, SYM),
    );
    expect(rebuilt.exportState()).toEqual(live.exportState());
    expect(live.restingCount).toBeGreaterThan(0);
    await expectInvariants();
  });

  it('random trading keeps every ledger invariant', async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => makeUser({ units: { [SYM]: 40 } })));
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const open: { id: number; acct: number }[] = [];
    for (let i = 0; i < 250; i++) {
      const u = users[Math.floor(rnd() * users.length)]!;
      const x = rnd();
      try {
        if (x < 0.65) {
          const side = rnd() < 0.5 ? 'BUY' : 'SELL';
          const o = await placeOrder(pool, ex, u.accountId, {
            symbol: SYM,
            side,
            type: 'LIMIT',
            tif: rnd() < 0.15 ? 'IOC' : 'GTC',
            qty: 1 + Math.floor(rnd() * 6),
            price: P + (Math.floor(rnd() * 9) - 4) * 10_000,
          });
          open.push({ id: o.id, acct: u.accountId });
        } else if (x < 0.8) {
          await placeOrder(pool, ex, u.accountId, {
            symbol: SYM,
            side: rnd() < 0.5 ? 'BUY' : 'SELL',
            type: 'MARKET',
            qty: 1 + Math.floor(rnd() * 4),
          });
        } else if (x < 0.93 && open.length) {
          const o = open.splice(Math.floor(rnd() * open.length), 1)[0]!;
          await requestCancel(pool, ex, [o.acct], o.id);
        } else if (open.length) {
          const o = open[Math.floor(rnd() * open.length)]!;
          await requestAmend(pool, ex, [o.acct], o.id, { qty: 1 + Math.floor(rnd() * 5) });
        }
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (!['INSUFFICIENT_FUNDS', 'INSUFFICIENT_QTY', 'NOT_OPEN', 'NOT_AMENDABLE'].includes(code ?? ''))
          throw e;
      }
    }
    const trades = (await pool.query('SELECT count(*)::int AS n FROM trades')).rows[0].n;
    expect(trades).toBeGreaterThan(20);
    await expectInvariants();
  });
});

describe('invariant checker', () => {
  it('detects a tampered balance and a missing hold', async () => {
    await resetDb();
    await seedInstrument(SYM, P);
    const ex = new InProcessExchange(pool);
    const u = await makeUser();
    await placeOrder(pool, ex, u.accountId, { symbol: SYM, side: 'BUY', type: 'LIMIT', qty: 1, price: P });
    expect((await checkInvariants(pool)).ok).toBe(true);
    await pool.query('UPDATE accounts SET cash_paise = cash_paise + 1, cash_held_paise = 0 WHERE id = $1', [
      u.accountId,
    ]);
    const r = await checkInvariants(pool);
    const failed = r.results.filter((x) => !x.ok).map((x) => x.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'cash-conserved-per-account',
        'total-cash-conserved',
        'holds-match-open-orders',
      ]),
    );
  });
});
