import { describe, expect, it } from 'vitest';
import { OrderBook } from '../src';
import { cfg, newBook, order, trades } from './helpers';

describe('OrderBook basics', () => {
  it('rests a limit order and reports best bid/ask', () => {
    const b = newBook();
    b.process(order(1, 'BUY', 5, 10_000));
    b.process(order(2, 'SELL', 3, 10_200));
    expect(b.bestBid()).toBe(10_000);
    expect(b.bestAsk()).toBe(10_200);
    expect(b.snapshot().bids).toEqual([{ price: 10_000, qty: 5, orders: 1 }]);
  });

  it('matches at the maker price (price improvement for the taker)', () => {
    const b = newBook();
    b.process(order(1, 'SELL', 2, 10_000));
    const t = trades(b.process(order(2, 'BUY', 2, 10_500)));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      price: 10_000,
      qty: 2,
      aggressor: 'BUY',
      buyAccountId: 2,
      sellAccountId: 1,
    });
    expect(b.bestAsk()).toBeUndefined();
    expect(b.bestBid()).toBeUndefined();
  });

  it('respects price priority, then time priority (FIFO)', () => {
    const b = newBook();
    const a = order(1, 'SELL', 1, 10_100);
    const bb = order(2, 'SELL', 1, 10_000); // better price, later
    const c = order(3, 'SELL', 1, 10_000); // same price, even later
    [a, bb, c].forEach((o) => b.process(o));
    const t = trades(b.process(order(4, 'BUY', 3, 10_100)));
    expect(t.map((x) => x.makerOrderId)).toEqual([bb.orderId, c.orderId, a.orderId]);
    expect(t.map((x) => x.price)).toEqual([10_000, 10_000, 10_100]);
  });

  it('partially fills and rests the remainder of a GTC limit', () => {
    const b = newBook();
    b.process(order(1, 'SELL', 2, 10_000));
    const evs = b.process(order(2, 'BUY', 5, 10_000));
    expect(trades(evs)[0]).toMatchObject({ qty: 2, takerRemaining: 3 });
    expect(b.snapshot().bids).toEqual([{ price: 10_000, qty: 3, orders: 1 }]);
  });

  it('IOC cancels the unfilled remainder', () => {
    const b = newBook();
    b.process(order(1, 'SELL', 2, 10_000));
    const evs = b.process(order(2, 'BUY', 5, 10_000, { tif: 'IOC' }));
    expect(evs.at(-1)).toMatchObject({ type: 'CANCELLED', reason: 'IOC_REMAINDER', remainingQty: 3 });
    expect(b.bestBid()).toBeUndefined();
  });

  it('FOK fills completely or not at all', () => {
    const b = newBook();
    b.process(order(1, 'SELL', 2, 10_000));
    const fail = b.process(order(2, 'BUY', 3, 10_000, { tif: 'FOK' }));
    expect(trades(fail)).toHaveLength(0);
    expect(fail.at(-1)).toMatchObject({ type: 'CANCELLED', reason: 'FOK_UNFILLABLE' });
    expect(b.bestAsk()).toBe(10_000);
    const ok = b.process(order(2, 'BUY', 2, 10_000, { tif: 'FOK' }));
    expect(trades(ok)).toHaveLength(1);
  });

  it('market order sweeps levels up to its protection price, then cancels the rest', () => {
    const b = newBook();
    b.process(order(1, 'SELL', 1, 10_000));
    b.process(order(1, 'SELL', 1, 10_100));
    b.process(order(1, 'SELL', 1, 12_000));
    const evs = b.process(order(2, 'BUY', 5, undefined, { protectPrice: 10_500 }));
    expect(trades(evs).map((t) => t.price)).toEqual([10_000, 10_100]);
    expect(evs.at(-1)).toMatchObject({ type: 'CANCELLED', reason: 'IOC_REMAINDER', remainingQty: 3 });
  });

  it('market order with no liquidity is cancelled', () => {
    const b = newBook();
    const evs = b.process(order(2, 'BUY', 1, undefined));
    expect(evs.at(-1)).toMatchObject({ type: 'CANCELLED', reason: 'NO_LIQUIDITY' });
  });

  it('prevents self-trades by cancelling the incoming order', () => {
    const b = newBook();
    b.process(order(1, 'SELL', 1, 10_000));
    b.process(order(7, 'SELL', 1, 10_100));
    const evs = b.process(order(7, 'BUY', 2, 10_100));
    expect(trades(evs)).toHaveLength(1); // trades with account 1 first
    expect(evs.at(-1)).toMatchObject({ type: 'CANCELLED', reason: 'SELF_TRADE', remainingQty: 1 });
    expect(b.bestAsk()).toBe(10_100); // own resting order untouched
  });

  it('rejects bad tick, bad lot, and prices outside the band', () => {
    const b = new OrderBook({ ...cfg, lotSizeUnits: 5 });
    expect(b.process(order(1, 'BUY', 5, 10_050))[0]).toMatchObject({ type: 'REJECTED', reason: 'BAD_TICK' });
    expect(b.process(order(1, 'BUY', 3, 10_000))[0]).toMatchObject({ type: 'REJECTED', reason: 'BAD_QTY' });
    b.process({ kind: 'MARK', price: 10_000, ts: 1 });
    expect(b.process(order(1, 'BUY', 5, 11_100))[0]).toMatchObject({
      type: 'REJECTED',
      reason: 'PRICE_BAND',
    });
    expect(b.process(order(1, 'BUY', 5, 11_000))[0]).toMatchObject({ type: 'ACCEPTED' });
  });

  it('ignores a duplicate order id (idempotent redelivery)', () => {
    const b = newBook();
    const o = order(1, 'BUY', 1, 10_000);
    expect(b.process(o)).toHaveLength(1);
    expect(b.process(o)).toHaveLength(0);
  });

  it('cancels only your own orders', () => {
    const b = newBook();
    const o = order(1, 'BUY', 1, 10_000);
    b.process(o);
    expect(b.process({ kind: 'CANCEL', orderId: o.orderId, accountId: 2, ts: 1 })[0]).toMatchObject({
      reason: 'NOT_OWNER',
    });
    expect(b.process({ kind: 'CANCEL', orderId: o.orderId, accountId: 1, ts: 1 })[0]).toMatchObject({
      type: 'CANCELLED',
      reason: 'USER',
    });
    expect(b.bestBid()).toBeUndefined();
  });

  it('amend: qty down keeps priority, price change loses it', () => {
    const b = newBook();
    const first = order(1, 'BUY', 5, 10_000);
    const second = order(2, 'BUY', 5, 10_000);
    b.process(first);
    b.process(second);
    b.process({ kind: 'AMEND', orderId: first.orderId, accountId: 1, newQty: 2, ts: 1 });
    let t = trades(b.process(order(3, 'SELL', 1, 10_000)));
    expect(t[0]!.makerOrderId).toBe(first.orderId);
    // move first away and back: it goes to the back of the queue
    b.process({ kind: 'AMEND', orderId: first.orderId, accountId: 1, newPrice: 9_900, ts: 2 });
    b.process({ kind: 'AMEND', orderId: first.orderId, accountId: 1, newPrice: 10_000, ts: 3 });
    t = trades(b.process(order(3, 'SELL', 1, 10_000)));
    expect(t[0]!.makerOrderId).toBe(second.orderId);
  });

  it('amend to a crossing price trades immediately', () => {
    const b = newBook();
    b.process(order(1, 'SELL', 1, 10_200));
    const bid = order(2, 'BUY', 1, 10_000);
    b.process(bid);
    const evs = b.process({ kind: 'AMEND', orderId: bid.orderId, accountId: 2, newPrice: 10_200, ts: 1 });
    expect(trades(evs)).toHaveLength(1);
  });

  it('stop-market sell triggers when the price falls to it', () => {
    const b = newBook();
    b.process(order(1, 'BUY', 1, 9_800));
    const stop = order(2, 'SELL', 1, undefined, {
      type: 'STOP_MARKET',
      stopPrice: 9_900,
      protectPrice: 9_000,
    });
    expect(b.process(stop).map((e) => e.type)).toEqual(['ACCEPTED']);
    const evs = b.process({ kind: 'MARK', price: 9_900, ts: 5 });
    expect(evs.map((e) => e.type)).toEqual(['STOP_TRIGGERED', 'TRADE']);
    expect(trades(evs)[0]).toMatchObject({ price: 9_800, sellOrderId: stop.orderId });
  });

  it('stop-limit buy rests as a limit order after triggering', () => {
    const b = newBook();
    b.process(order(2, 'BUY', 2, 10_300, { type: 'STOP_LIMIT', stopPrice: 10_200 }));
    expect(b.bestBid()).toBeUndefined(); // stops are invisible until triggered
    b.process(order(1, 'SELL', 1, 10_200));
    const evs = b.process(order(3, 'BUY', 1, 10_200)); // trade at 10_200 → stop fires
    expect(evs.map((e) => e.type)).toEqual(['ACCEPTED', 'TRADE', 'STOP_TRIGGERED']);
    expect(b.bestBid()).toBe(10_300);
  });

  it('halt rejects new orders but still allows cancels', () => {
    const b = newBook();
    const o = order(1, 'BUY', 1, 10_000);
    b.process(o);
    b.process({ kind: 'HALT', ts: 1 });
    expect(b.process(order(2, 'SELL', 1, 10_000))[0]).toMatchObject({ type: 'REJECTED', reason: 'HALTED' });
    expect(b.process({ kind: 'CANCEL', orderId: o.orderId, accountId: 1, ts: 2 })[0]).toMatchObject({
      type: 'CANCELLED',
    });
    b.process({ kind: 'RESUME', ts: 3 });
    expect(b.process(order(2, 'SELL', 1, 10_000))[0]).toMatchObject({ type: 'ACCEPTED' });
  });

  it('replays its event log into an identical book', () => {
    const b = newBook();
    const log = [
      ...b.process(order(1, 'BUY', 5, 10_000)),
      ...b.process(order(2, 'SELL', 2, 10_000)),
      ...b.process(order(3, 'SELL', 4, 10_300)),
      ...b.process(order(4, 'BUY', 1, 10_400, { type: 'STOP_LIMIT', stopPrice: 10_500 })),
    ];
    expect(OrderBook.replay(cfg, log).exportState()).toEqual(b.exportState());
  });

  it('refuses a replay log with a sequence gap', () => {
    const b = newBook();
    const log = [...b.process(order(1, 'BUY', 5, 10_000)), ...b.process(order(2, 'BUY', 5, 10_000))];
    expect(() => OrderBook.replay(cfg, [log[1]!])).toThrow(/gap/);
  });
});

describe('stale NEW orders', () => {
  it('rejectNew emits one REJECTED event and makes a later redelivery of the same order a no-op', () => {
    const b = newBook();
    b.process(order(1, 'SELL', 2, 10_000));
    const late = order(2, 'BUY', 2, 10_000);
    const evs = b.rejectNew(late, 'STALE');
    expect(evs).toEqual([
      expect.objectContaining({ type: 'REJECTED', orderId: late.orderId, reason: 'STALE', cmd: 'NEW' }),
    ]);
    // the same command arriving again (e.g. redelivered from the stream) must not trade
    expect(b.process(late)).toEqual([]);
    expect(b.rejectNew(late, 'STALE')).toEqual([]);
    expect(b.bestAsk()).toBe(10_000); // the resting ask is untouched
  });
});
