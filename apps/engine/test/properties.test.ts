import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  holdFor,
  holdPrice,
  notional,
  protectionPrice,
  type EngineCommand,
  type EngineEvent,
  type OrderType,
  type Side,
  type TimeInForce,
} from '@tradecore/shared';
import { OrderBook } from '../src';
import { cfg } from './helpers';

/**
 * Property-based tests: fast-check generates thousands of random command sequences and we check
 * invariants that must hold for EVERY sequence, not just the examples we thought of.
 */

const QTY_SCALE = 100; // tick (100) % qtyScale (100) === 0 → notionals are integral
const ACCOUNTS = [1, 2, 3, 4];
const START_CASH = 50_000;
const START_UNITS = 30;

type Spec =
  | {
      k: 'new';
      acct: number;
      side: Side;
      type: OrderType;
      tif: TimeInForce;
      qty: number;
      px: number;
      stopPx: number;
    }
  | { k: 'cancel'; pick: number; acct: number | null }
  | { k: 'amend'; pick: number; qty: number | null; px: number | null }
  | { k: 'mark'; px: number }
  | { k: 'halt' }
  | { k: 'resume' };

// prices cluster around 100 ticks so orders cross and queue up at the same levels
const tickPx = fc.integer({ min: 96, max: 104 }).map((t) => t * 100);
const markPx = fc.integer({ min: 97, max: 103 }).map((t) => t * 100);
const specArb: fc.Arbitrary<Spec> = fc.oneof(
  {
    weight: 25,
    arbitrary: fc.record({
      k: fc.constant('new' as const),
      acct: fc.constantFrom(...ACCOUNTS),
      side: fc.constantFrom<Side>('BUY', 'SELL'),
      type: fc.constantFrom<OrderType>('LIMIT', 'LIMIT', 'LIMIT', 'MARKET', 'STOP_MARKET', 'STOP_LIMIT'),
      tif: fc.constantFrom<TimeInForce>('GTC', 'GTC', 'IOC', 'FOK'),
      qty: fc.integer({ min: 1, max: 8 }),
      px: tickPx,
      stopPx: tickPx,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('cancel' as const),
      pick: fc.nat(),
      acct: fc.option(fc.constantFrom(...ACCOUNTS)),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('amend' as const),
      pick: fc.nat(),
      qty: fc.option(fc.integer({ min: 1, max: 8 })),
      px: fc.option(tickPx),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('mark' as const), px: markPx }) },
  { weight: 1, arbitrary: fc.constant({ k: 'halt' as const }) },
  { weight: 4, arbitrary: fc.constant({ k: 'resume' as const }) },
);

interface OrderState {
  acct: number;
  side: Side;
  type: OrderType;
  holdPrice?: number;
  heldCash: number;
  heldUnits: number;
  remaining: number;
  filled: number;
  open: boolean;
}

/** Simulates the API's pre-trade risk checks and the settler's balance updates. */
class Harness {
  book = new OrderBook(cfg);
  log: EngineEvent[] = [];
  cash = new Map(ACCOUNTS.map((a) => [a, START_CASH]));
  units = new Map(ACCOUNTS.map((a) => [a, START_UNITS]));
  heldCash = new Map(ACCOUNTS.map((a) => [a, 0]));
  heldUnits = new Map(ACCOUNTS.map((a) => [a, 0]));
  orders = new Map<number, OrderState>();
  ids: number[] = [];
  nextId = 1;
  ts = 1;

  avail(map: Map<number, number>, held: Map<number, number>, a: number) {
    return map.get(a)! - held.get(a)!;
  }
  add(map: Map<number, number>, a: number, d: number) {
    map.set(a, map.get(a)! + d);
  }

  toCommand(s: Spec): EngineCommand | null {
    const ts = this.ts++;
    switch (s.k) {
      case 'new': {
        const isLimit = s.type === 'LIMIT' || s.type === 'STOP_LIMIT';
        const isStop = s.type === 'STOP_MARKET' || s.type === 'STOP_LIMIT';
        const tif: TimeInForce = !isLimit && s.tif === 'GTC' ? 'IOC' : s.tif;
        const ref = isStop ? s.stopPx : (this.book.markPrice ?? 10_000);
        const cmd = {
          kind: 'NEW' as const,
          orderId: this.nextId++,
          accountId: s.acct,
          side: s.side,
          type: s.type,
          tif,
          qty: s.qty,
          price: isLimit ? s.px : undefined,
          stopPrice: isStop ? s.stopPx : undefined,
          protectPrice: isLimit
            ? undefined
            : protectionPrice(s.side, ref, cfg.priceBandBps, cfg.tickSizePaise),
          ts,
        };
        // pre-trade risk: reserve funds or reject before the order reaches the engine
        const h = holdFor(cmd, QTY_SCALE);
        if (h.cash > this.avail(this.cash, this.heldCash, s.acct)) return null;
        if (h.units > this.avail(this.units, this.heldUnits, s.acct)) return null;
        this.add(this.heldCash, s.acct, h.cash);
        this.add(this.heldUnits, s.acct, h.units);
        this.orders.set(cmd.orderId, {
          acct: s.acct,
          side: s.side,
          type: s.type,
          holdPrice: holdPrice(cmd),
          heldCash: h.cash,
          heldUnits: h.units,
          remaining: s.qty,
          filled: 0,
          open: true,
        });
        this.ids.push(cmd.orderId);
        return cmd;
      }
      case 'cancel': {
        if (this.ids.length === 0) return null;
        const id = this.ids[s.pick % this.ids.length]!;
        return { kind: 'CANCEL', orderId: id, accountId: s.acct ?? this.orders.get(id)!.acct, ts };
      }
      case 'amend': {
        if (this.ids.length === 0) return null;
        const id = this.ids[s.pick % this.ids.length]!;
        const o = this.orders.get(id)!;
        const live = this.book.getOrder(id);
        if (live && o.side === 'BUY') {
          // reserve extra cash first if the amended order needs more
          const need = notional(s.px ?? live.price, s.qty ?? live.qty, QTY_SCALE) - o.heldCash;
          if (need > this.avail(this.cash, this.heldCash, o.acct)) return null;
        }
        if (
          live &&
          o.side === 'SELL' &&
          (s.qty ?? live.qty) - o.heldUnits > this.avail(this.units, this.heldUnits, o.acct)
        )
          return null;
        return {
          kind: 'AMEND',
          orderId: id,
          accountId: o.acct,
          newQty: s.qty ?? undefined,
          newPrice: s.px ?? undefined,
          ts,
        };
      }
      case 'mark':
        return { kind: 'MARK', price: s.px, ts };
      case 'halt':
        return { kind: 'HALT', ts };
      case 'resume':
        return { kind: 'RESUME', ts };
    }
  }

  release(o: OrderState) {
    this.add(this.heldCash, o.acct, -o.heldCash);
    this.add(this.heldUnits, o.acct, -o.heldUnits);
    o.heldCash = 0;
    o.heldUnits = 0;
    o.remaining = 0;
    o.open = false;
  }

  settle(e: EngineEvent) {
    switch (e.type) {
      case 'TRADE': {
        const buy = this.orders.get(e.buyOrderId)!;
        const sell = this.orders.get(e.sellOrderId)!;
        const cost = notional(e.price, e.qty, QTY_SCALE);
        const releaseCash = notional(buy.holdPrice!, e.qty, QTY_SCALE);
        expect(cost).toBeLessThanOrEqual(releaseCash); // never pay more than you reserved for
        buy.heldCash -= releaseCash;
        this.add(this.heldCash, buy.acct, -releaseCash);
        this.add(this.cash, buy.acct, -cost);
        this.add(this.units, buy.acct, e.qty);
        sell.heldUnits -= e.qty;
        this.add(this.heldUnits, sell.acct, -e.qty);
        this.add(this.units, sell.acct, -e.qty);
        this.add(this.cash, sell.acct, cost);
        for (const o of [buy, sell]) {
          o.remaining -= e.qty;
          o.filled += e.qty;
          if (o.remaining === 0) this.release(o);
        }
        break;
      }
      case 'CANCELLED':
        this.release(this.orders.get(e.orderId)!);
        break;
      case 'REJECTED':
        if (e.isNew) this.release(this.orders.get(e.orderId)!);
        break;
      case 'AMENDED': {
        const o = this.orders.get(e.orderId)!;
        if (o.side === 'BUY') {
          const newHold = notional(e.newPrice!, e.newQty, QTY_SCALE);
          this.add(this.heldCash, o.acct, newHold - o.heldCash);
          o.heldCash = newHold;
          o.holdPrice = e.newPrice;
        } else {
          this.add(this.heldUnits, o.acct, e.newQty - o.heldUnits);
          o.heldUnits = e.newQty;
        }
        o.remaining = e.newQty;
        break;
      }
    }
  }

  /** Opposite-side resting order ids in priority order (best price first, FIFO within a price). */
  priorityList(side: Side): number[] {
    const st = this.book.exportState();
    return (side === 'BUY' ? st.asks : st.bids).flatMap((l) => l.orders.map((o) => o[0]));
  }

  step(s: Spec) {
    const cmd = this.toCommand(s);
    if (!cmd) return;
    const before =
      cmd.kind === 'NEW' && (cmd.type === 'LIMIT' || cmd.type === 'MARKET')
        ? this.priorityList(cmd.side)
        : null;
    const evs = this.book.process(cmd);
    this.log.push(...evs);
    for (const e of evs) this.settle(e);

    // price-time priority: the makers hit by a plain limit/market order are exactly a prefix of the queue
    if (before) {
      const firstStop = evs.findIndex((e) => e.type === 'STOP_TRIGGERED');
      const makers = (firstStop < 0 ? evs : evs.slice(0, firstStop))
        .filter((e) => e.type === 'TRADE')
        .map((e) => (e as Extract<EngineEvent, { type: 'TRADE' }>).makerOrderId);
      const distinct = makers.filter((m, i) => makers.indexOf(m) === i);
      expect(distinct).toEqual(before.slice(0, distinct.length));
    }
    this.checkInvariants();
  }

  checkInvariants() {
    // 1. the book is never crossed after matching
    const bid = this.book.bestBid();
    const ask = this.book.bestAsk();
    if (bid !== undefined && ask !== undefined) expect(bid).toBeLessThan(ask);

    // 2. cash and quantity are conserved; nothing negative; holds never exceed balances
    const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    expect(sum(this.cash)).toBe(START_CASH * ACCOUNTS.length);
    expect(sum(this.units)).toBe(START_UNITS * ACCOUNTS.length);
    for (const a of ACCOUNTS) {
      expect(this.heldCash.get(a)!).toBeGreaterThanOrEqual(0);
      expect(this.heldUnits.get(a)!).toBeGreaterThanOrEqual(0);
      expect(this.heldCash.get(a)!).toBeLessThanOrEqual(this.cash.get(a)!);
      expect(this.heldUnits.get(a)!).toBeLessThanOrEqual(this.units.get(a)!);
    }

    // 3. every order's remaining quantity matches the book, and holds match what's still open
    const st = this.book.exportState();
    const inBook = new Map<number, number>();
    for (const l of [...st.bids, ...st.asks]) {
      expect(l.orders.reduce((a, o) => a + o[2], 0)).toBe(l.totalQty);
      for (const [id, , q] of l.orders) inBook.set(id, q);
    }
    for (const [id, , q] of [...st.buyStops, ...st.sellStops] as [number, number, number][])
      inBook.set(id, q);
    for (const [id, o] of this.orders) {
      expect(o.remaining).toBe(inBook.get(id) ?? 0);
      expect(o.open).toBe(inBook.has(id));
      if (o.open && o.side === 'BUY') expect(o.heldCash).toBe(notional(o.holdPrice!, o.remaining, QTY_SCALE));
      if (o.open && o.side === 'SELL') expect(o.heldUnits).toBe(o.remaining);
    }
  }
}

describe('matching engine properties', () => {
  it('keeps all invariants for any command sequence, and replay reproduces the book', () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 20, maxLength: 200 }), (specs) => {
        const h = new Harness();
        for (const s of specs) h.step(s);
        const replayed = OrderBook.replay(cfg, h.log);
        expect(replayed.exportState()).toEqual(h.book.exportState());
        // sequence numbers are gap-free
        h.log.forEach((e, i) => expect(e.seq).toBe(i + 1));
      }),
      { numRuns: 400 },
    );
  });

  it('replay from any prefix of the log matches the live book at that point', () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 10, maxLength: 100 }), fc.nat(), (specs, cut) => {
        const h = new Harness();
        const states: { seq: number; state: ReturnType<OrderBook['exportState']> }[] = [];
        for (const s of specs) {
          h.step(s);
          states.push({ seq: h.book.seq, state: h.book.exportState() });
        }
        const at = states[cut % states.length]!;
        expect(OrderBook.replay(cfg, h.log.slice(0, at.seq)).exportState()).toEqual(at.state);
      }),
      { numRuns: 200 },
    );
  });
});
