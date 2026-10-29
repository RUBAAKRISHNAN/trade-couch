import type {
  AmendCommand,
  BookSnapshot,
  CancelCommand,
  CancelReason,
  EngineCommand,
  EngineEvent,
  NewOrderCommand,
  RejectReason,
  Side,
  TimeInForce,
} from '@tradecore/shared';
import { BookSide, type RestingOrder } from './levels';

export interface BookConfig {
  symbol: string;
  tickSizePaise: number;
  lotSizeUnits: number;
  priceBandBps: number;
}

/** A stop order waiting (invisibly) for its trigger price. */
interface StopOrder {
  orderId: number;
  accountId: number;
  side: Side;
  type: 'STOP_MARKET' | 'STOP_LIMIT';
  tif: TimeInForce;
  qty: number;
  stopPrice: number;
  price?: number;
  protectPrice?: number;
  ts: number;
  /** arrival order, used to break ties between equal stop prices */
  arrival: number;
}

/** An incoming order looking for liquidity. limit undefined = no price limit. */
interface Taker {
  orderId: number;
  accountId: number;
  side: Side;
  limit: number | undefined;
  remaining: number;
  tif: TimeInForce;
  isMarket: boolean;
  ts: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventInput = DistributiveOmit<EngineEvent, 'seq' | 'symbol'>;

/**
 * A single-symbol limit order book with a price-time priority matching engine.
 *
 * It is deterministic: the same commands always produce the same events, because time comes from
 * the command (ts), never from the clock. Every state change is emitted as an event with a
 * sequence number, and `apply(event)` rebuilds the exact same state from the event log
 * (event sourcing). The engine is single-threaded per symbol: commands are processed one at a time.
 */
export class OrderBook {
  readonly bids = new BookSide('BUY');
  readonly asks = new BookSide('SELL');
  private orders = new Map<number, RestingOrder>();
  /** buy stops fire when price rises to them; sorted so the next to fire is at the end */
  private buyStops: StopOrder[] = [];
  /** sell stops fire when price falls to them; sorted so the next to fire is at the end */
  private sellStops: StopOrder[] = [];
  private stopIndex = new Map<number, StopOrder>();
  /** every order id ever accepted or rejected, so a redelivered command is ignored (idempotency) */
  private seen = new Set<number>();
  private arrival = 0;

  seq = 0;
  lastPrice: number | undefined;
  markPrice: number | undefined;
  halted = false;

  private out: EngineEvent[] = [];

  constructor(readonly cfg: BookConfig) {}

  // ───────────────────────────── command side ─────────────────────────────

  /** Process one command and return the events it produced, in order. */
  process(cmd: EngineCommand): EngineEvent[] {
    this.out = [];
    switch (cmd.kind) {
      case 'NEW':
        this.onNew(cmd);
        break;
      case 'CANCEL':
        this.onCancel(cmd);
        break;
      case 'AMEND':
        this.onAmend(cmd);
        break;
      case 'MARK':
        this.markPrice = cmd.price;
        this.runStops(cmd.ts);
        break;
      case 'HALT':
        if (!this.halted) this.emit({ type: 'HALTED', ts: cmd.ts });
        this.halted = true;
        break;
      case 'RESUME':
        if (this.halted) this.emit({ type: 'RESUMED', ts: cmd.ts });
        this.halted = false;
        break;
    }
    return this.out;
  }

  private emit(e: EventInput): void {
    const ev = { ...e, seq: ++this.seq, symbol: this.cfg.symbol } as EngineEvent;
    this.out.push(ev);
  }

  private reject(
    cmd: { orderId: number; accountId: number; ts: number },
    reason: RejectReason,
    kind: 'NEW' | 'CANCEL' | 'AMEND',
  ) {
    this.emit({
      type: 'REJECTED',
      orderId: cmd.orderId,
      accountId: cmd.accountId,
      reason,
      cmd: kind,
      ts: cmd.ts,
    });
  }

  private validPrice(p: number | undefined): boolean {
    return p === undefined || (Number.isSafeInteger(p) && p > 0 && p % this.cfg.tickSizePaise === 0);
  }

  private validQty(q: number): boolean {
    return Number.isSafeInteger(q) && q > 0 && q % this.cfg.lotSizeUnits === 0;
  }

  /** Price band: reject limit prices too far from the reference price (protects against fat fingers). */
  private outsideBand(price: number): boolean {
    if (this.markPrice === undefined) return false;
    const maxDev = (this.markPrice * this.cfg.priceBandBps) / 10_000;
    return Math.abs(price - this.markPrice) > maxDev;
  }

  private onNew(cmd: NewOrderCommand): void {
    if (this.seen.has(cmd.orderId)) return; // duplicate delivery: already handled, emit nothing
    if (this.halted) return this.reject(cmd, 'HALTED', 'NEW');
    const isStop = cmd.type === 'STOP_MARKET' || cmd.type === 'STOP_LIMIT';
    const needsPrice = cmd.type === 'LIMIT' || cmd.type === 'STOP_LIMIT';
    const isMarket = cmd.type === 'MARKET' || cmd.type === 'STOP_MARKET';
    if (!this.validQty(cmd.qty)) return this.reject(cmd, 'BAD_QTY', 'NEW');
    // TODO(me) [Phase 2 task, ~30 min]: add an optional `maxOrderQty` to BookConfig and reject NEW orders above it
    //   with a new RejectReason 'MAX_QTY' (add it in packages/shared/src/engine-types.ts). Write a unit test in
    //   test/order-book.test.ts. Question to answer in the test name: why is this a "fat-finger" protection?
    if (
      (needsPrice && cmd.price === undefined) ||
      (!needsPrice && cmd.price !== undefined) ||
      (isStop && cmd.stopPrice === undefined) ||
      (isMarket && cmd.tif === 'GTC')
    )
      return this.reject(cmd, 'BAD_PARAMS', 'NEW');
    if (!this.validPrice(cmd.price) || !this.validPrice(cmd.stopPrice) || !this.validPrice(cmd.protectPrice))
      return this.reject(cmd, 'BAD_TICK', 'NEW');
    if (cmd.price !== undefined && this.outsideBand(cmd.price)) return this.reject(cmd, 'PRICE_BAND', 'NEW');

    this.emit({
      type: 'ACCEPTED',
      ts: cmd.ts,
      order: {
        orderId: cmd.orderId,
        accountId: cmd.accountId,
        side: cmd.side,
        type: cmd.type,
        tif: cmd.tif,
        qty: cmd.qty,
        price: cmd.price,
        stopPrice: cmd.stopPrice,
        protectPrice: cmd.protectPrice,
        ts: cmd.ts,
      },
    });
    this.seen.add(cmd.orderId);

    if (isStop) {
      this.addStop({
        orderId: cmd.orderId,
        accountId: cmd.accountId,
        side: cmd.side,
        type: cmd.type as StopOrder['type'],
        tif: cmd.tif,
        qty: cmd.qty,
        stopPrice: cmd.stopPrice!,
        price: cmd.price,
        protectPrice: cmd.protectPrice,
        ts: cmd.ts,
        arrival: ++this.arrival,
      });
      this.runStops(cmd.ts); // it may already be triggered
      return;
    }

    this.match({
      orderId: cmd.orderId,
      accountId: cmd.accountId,
      side: cmd.side,
      limit: isMarket ? cmd.protectPrice : cmd.price,
      remaining: cmd.qty,
      tif: cmd.tif,
      isMarket,
      ts: cmd.ts,
    });
    this.runStops(cmd.ts);
  }

  private crosses(side: Side, limit: number | undefined, makerPrice: number): boolean {
    if (limit === undefined) return true;
    return side === 'BUY' ? makerPrice <= limit : makerPrice >= limit;
  }

  /** Quantity the taker could fill right now (stopping at its own order, where self-trade prevention kicks in). */
  private fillable(t: Taker): number {
    const book = t.side === 'BUY' ? this.asks : this.bids;
    let total = 0;
    for (const lvl of book.levels()) {
      if (!this.crosses(t.side, t.limit, lvl.price)) break;
      for (let o = lvl.head; o; o = o.next) {
        if (o.accountId === t.accountId) return total;
        total += o.qty;
        if (total >= t.remaining) return total;
      }
    }
    return total;
  }

  /**
   * The matching loop. Price priority: always trade against the best opposite price first.
   * Time priority: within a price, the oldest order (FIFO head) trades first.
   * Trades happen at the RESTING (maker) order's price.
   */
  private match(t: Taker): void {
    if (t.tif === 'FOK' && this.fillable(t) < t.remaining) {
      this.emit({
        type: 'CANCELLED',
        orderId: t.orderId,
        accountId: t.accountId,
        remainingQty: t.remaining,
        reason: 'FOK_UNFILLABLE',
        ts: t.ts,
      });
      return;
    }
    const opposite = t.side === 'BUY' ? this.asks : this.bids;
    let filled = 0;
    while (t.remaining > 0) {
      const lvl = opposite.best();
      if (!lvl || !this.crosses(t.side, t.limit, lvl.price)) break;
      const maker = lvl.head!;
      if (maker.accountId === t.accountId) {
        // Self-trade prevention ("cancel newest"): you can't trade with yourself; cancel the incoming remainder.
        this.cancelTaker(t, 'SELF_TRADE');
        return;
      }
      const qty = Math.min(t.remaining, maker.qty);
      maker.qty -= qty;
      lvl.totalQty -= qty;
      t.remaining -= qty;
      filled += qty;
      this.lastPrice = lvl.price;
      const buy = t.side === 'BUY' ? t : maker;
      const sell = t.side === 'BUY' ? maker : t;
      this.emit({
        type: 'TRADE',
        ts: t.ts,
        price: lvl.price,
        qty,
        makerOrderId: maker.orderId,
        takerOrderId: t.orderId,
        buyOrderId: buy.orderId,
        sellOrderId: sell.orderId,
        buyAccountId: buy.accountId,
        sellAccountId: sell.accountId,
        aggressor: t.side,
        makerRemaining: maker.qty,
        takerRemaining: t.remaining,
      });
      if (maker.qty === 0) {
        lvl.remove(maker);
        this.orders.delete(maker.orderId);
        if (lvl.isEmpty()) opposite.removeLevel(lvl.price);
      }
    }
    if (t.remaining === 0) return;
    if (t.tif === 'GTC' && !t.isMarket && t.limit !== undefined) {
      this.rest(t.orderId, t.accountId, t.side, t.limit, t.remaining, t.ts);
    } else {
      this.cancelTaker(t, t.isMarket && filled === 0 ? 'NO_LIQUIDITY' : 'IOC_REMAINDER');
    }
  }

  private cancelTaker(t: Taker, reason: CancelReason): void {
    this.emit({
      type: 'CANCELLED',
      orderId: t.orderId,
      accountId: t.accountId,
      remainingQty: t.remaining,
      reason,
      ts: t.ts,
    });
  }

  private rest(orderId: number, accountId: number, side: Side, price: number, qty: number, ts: number): void {
    const o: RestingOrder = {
      orderId,
      accountId,
      side,
      price,
      qty,
      tif: 'GTC',
      ts,
      prev: null,
      next: null,
      level: null,
    };
    (side === 'BUY' ? this.bids : this.asks).getOrCreate(price).push(o);
    this.orders.set(orderId, o);
  }

  private unrest(o: RestingOrder): void {
    const side = o.side === 'BUY' ? this.bids : this.asks;
    const lvl = o.level!;
    lvl.remove(o);
    if (lvl.isEmpty()) side.removeLevel(lvl.price);
    this.orders.delete(o.orderId);
  }

  private onCancel(cmd: CancelCommand): void {
    const o = this.orders.get(cmd.orderId);
    const s = this.stopIndex.get(cmd.orderId);
    if (!o && !s) return this.reject(cmd, 'UNKNOWN_ORDER', 'CANCEL');
    if ((o ?? s)!.accountId !== cmd.accountId) return this.reject(cmd, 'NOT_OWNER', 'CANCEL');
    const remainingQty = o ? o.qty : s!.qty;
    if (o) this.unrest(o);
    else this.removeStop(s!);
    this.emit({
      type: 'CANCELLED',
      orderId: cmd.orderId,
      accountId: cmd.accountId,
      remainingQty,
      reason: 'USER',
      ts: cmd.ts,
    });
  }

  /**
   * Amend a resting limit order. Reducing quantity keeps your place in the queue (it doesn't hurt
   * anyone behind you). Any price change or quantity increase sends the order to the back of the queue,
   * and a new price may even cross the spread and trade immediately.
   */
  private onAmend(cmd: AmendCommand): void {
    if (this.halted) return this.reject(cmd, 'HALTED', 'AMEND');
    const o = this.orders.get(cmd.orderId);
    if (!o) return this.reject(cmd, 'UNKNOWN_ORDER', 'AMEND');
    if (o.accountId !== cmd.accountId) return this.reject(cmd, 'NOT_OWNER', 'AMEND');
    const newQty = cmd.newQty ?? o.qty;
    const newPrice = cmd.newPrice ?? o.price;
    if (!this.validQty(newQty)) return this.reject(cmd, 'BAD_QTY', 'AMEND');
    if (!this.validPrice(newPrice)) return this.reject(cmd, 'BAD_TICK', 'AMEND');
    if (newPrice !== o.price && this.outsideBand(newPrice)) return this.reject(cmd, 'PRICE_BAND', 'AMEND');

    if (newPrice === o.price && newQty <= o.qty) {
      o.level!.totalQty -= o.qty - newQty;
      o.qty = newQty;
      this.emit({
        type: 'AMENDED',
        orderId: o.orderId,
        accountId: o.accountId,
        newQty,
        newPrice,
        lostPriority: false,
        ts: cmd.ts,
      });
      return;
    }
    this.unrest(o);
    this.emit({
      type: 'AMENDED',
      orderId: o.orderId,
      accountId: o.accountId,
      newQty,
      newPrice,
      lostPriority: true,
      ts: cmd.ts,
    });
    this.match({
      orderId: o.orderId,
      accountId: o.accountId,
      side: o.side,
      limit: newPrice,
      remaining: newQty,
      tif: 'GTC',
      isMarket: false,
      ts: cmd.ts,
    });
    this.runStops(cmd.ts);
  }

  // ───────────────────────────── stops ─────────────────────────────

  /** true if a fires before b */
  private firesBefore(a: StopOrder, b: StopOrder): boolean {
    if (a.stopPrice !== b.stopPrice)
      return a.side === 'BUY' ? a.stopPrice < b.stopPrice : a.stopPrice > b.stopPrice;
    return a.arrival < b.arrival;
  }

  private addStop(s: StopOrder): void {
    const arr = s.side === 'BUY' ? this.buyStops : this.sellStops;
    // arr is ordered "fires last" → "fires first"; find first index whose element fires before s
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.firesBefore(arr[mid]!, s)) hi = mid;
      else lo = mid + 1;
    }
    arr.splice(lo, 0, s);
    this.stopIndex.set(s.orderId, s);
  }

  private removeStop(s: StopOrder): void {
    const arr = s.side === 'BUY' ? this.buyStops : this.sellStops;
    const i = arr.indexOf(s);
    if (i >= 0) arr.splice(i, 1);
    this.stopIndex.delete(s.orderId);
  }

  private isTriggered(s: StopOrder): boolean {
    const prices = [this.lastPrice, this.markPrice].filter((p): p is number => p !== undefined);
    return s.side === 'BUY' ? prices.some((p) => p >= s.stopPrice) : prices.some((p) => p <= s.stopPrice);
  }

  private nextTriggered(): StopOrder | undefined {
    const b = this.buyStops[this.buyStops.length - 1];
    const s = this.sellStops[this.sellStops.length - 1];
    const cands = [b, s].filter((x): x is StopOrder => !!x && this.isTriggered(x));
    if (cands.length === 0) return undefined;
    return cands.reduce((x, y) => (x.arrival < y.arrival ? x : y));
  }

  /**
   * Fire every stop whose trigger price has been reached. A stop-market becomes a market order
   * (limited by its protection price); a stop-limit becomes a limit order. Their trades can move the
   * price and trigger more stops (a "stop cascade"), so we loop until nothing more fires.
   */
  private runStops(ts: number): void {
    if (this.halted) return;
    for (let s = this.nextTriggered(); s; s = this.nextTriggered()) {
      this.removeStop(s);
      const triggerPrice =
        s.side === 'BUY'
          ? Math.max(this.lastPrice ?? 0, this.markPrice ?? 0)
          : Math.min(this.lastPrice ?? Infinity, this.markPrice ?? Infinity);
      this.emit({ type: 'STOP_TRIGGERED', orderId: s.orderId, accountId: s.accountId, triggerPrice, ts });
      const isMarket = s.type === 'STOP_MARKET';
      this.match({
        orderId: s.orderId,
        accountId: s.accountId,
        side: s.side,
        limit: isMarket ? s.protectPrice : s.price,
        remaining: s.qty,
        tif: isMarket ? (s.tif === 'FOK' ? 'FOK' : 'IOC') : s.tif,
        isMarket,
        ts,
      });
    }
  }

  // ───────────────────────────── event sourcing: replay ─────────────────────────────

  /**
   * Apply one event from the log to rebuild state (no matching, no new events).
   * Replaying the full log for a symbol reproduces exactly the book the live engine had.
   */
  apply(e: EngineEvent): void {
    if (e.seq !== this.seq + 1)
      throw new Error(`replay gap for ${this.cfg.symbol}: expected ${this.seq + 1}, got ${e.seq}`);
    this.seq = e.seq;
    switch (e.type) {
      case 'ACCEPTED': {
        const o = e.order;
        this.seen.add(o.orderId);
        if (o.type === 'STOP_MARKET' || o.type === 'STOP_LIMIT') {
          this.addStop({ ...o, type: o.type, stopPrice: o.stopPrice!, arrival: ++this.arrival });
        } else if (o.type === 'LIMIT' && o.tif === 'GTC') {
          // A GTC limit order rests with its full size; following TRADE events (as taker) shrink it.
          this.rest(o.orderId, o.accountId, o.side, o.price!, o.qty, o.ts);
        }
        break;
      }
      case 'REJECTED':
        if (e.cmd === 'NEW') this.seen.add(e.orderId);
        break;
      case 'STOP_TRIGGERED': {
        const s = this.stopIndex.get(e.orderId);
        if (!s) throw new Error(`replay: unknown stop ${e.orderId}`);
        this.removeStop(s);
        if (s.type === 'STOP_LIMIT' && s.tif === 'GTC')
          this.rest(s.orderId, s.accountId, s.side, s.price!, s.qty, e.ts);
        break;
      }
      case 'TRADE': {
        this.lastPrice = e.price;
        for (const id of [e.makerOrderId, e.takerOrderId]) {
          const o = this.orders.get(id);
          if (!o) continue;
          o.qty -= e.qty;
          o.level!.totalQty -= e.qty;
          if (o.qty === 0) this.unrest(o);
        }
        break;
      }
      case 'CANCELLED': {
        const o = this.orders.get(e.orderId);
        if (o) this.unrest(o);
        const s = this.stopIndex.get(e.orderId);
        if (s) this.removeStop(s);
        break;
      }
      case 'AMENDED': {
        const o = this.orders.get(e.orderId);
        if (!o) throw new Error(`replay: unknown amended order ${e.orderId}`);
        if (e.lostPriority) {
          this.unrest(o);
          this.rest(o.orderId, o.accountId, o.side, e.newPrice ?? o.price, e.newQty, e.ts);
        } else {
          o.level!.totalQty -= o.qty - e.newQty;
          o.qty = e.newQty;
        }
        break;
      }
      case 'HALTED':
        this.halted = true;
        break;
      case 'RESUMED':
        this.halted = false;
        break;
    }
  }

  static replay(cfg: BookConfig, events: Iterable<EngineEvent>): OrderBook {
    const b = new OrderBook(cfg);
    for (const e of events) b.apply(e);
    return b;
  }

  // ───────────────────────────── queries ─────────────────────────────

  bestBid(): number | undefined {
    return this.bids.best()?.price;
  }
  bestAsk(): number | undefined {
    return this.asks.best()?.price;
  }
  hasOrder(orderId: number): boolean {
    return this.orders.has(orderId) || this.stopIndex.has(orderId);
  }
  getOrder(orderId: number): { qty: number; price: number; side: Side; accountId: number } | undefined {
    const o = this.orders.get(orderId);
    return o && { qty: o.qty, price: o.price, side: o.side, accountId: o.accountId };
  }
  get restingCount(): number {
    return this.orders.size;
  }

  snapshot(depth = 20, ts = 0): BookSnapshot {
    const take = (side: BookSide) => {
      const out = [];
      for (const l of side.levels()) {
        if (out.length >= depth) break;
        out.push({ price: l.price, qty: l.totalQty, orders: l.count });
      }
      return out;
    };
    return {
      symbol: this.cfg.symbol,
      seq: this.seq,
      bids: take(this.bids),
      asks: take(this.asks),
      lastPrice: this.lastPrice,
      markPrice: this.markPrice,
      halted: this.halted,
      ts,
    };
  }

  /** Full canonical state, for tests (replay must reproduce it exactly). */
  exportState() {
    const dump = (side: BookSide) =>
      [...side.levels()].map((l) => {
        const orders: [number, number, number][] = [];
        for (let o = l.head; o; o = o.next) orders.push([o.orderId, o.accountId, o.qty]);
        return { price: l.price, totalQty: l.totalQty, orders };
      });
    const stops = (arr: StopOrder[]) => arr.map((s) => [s.orderId, s.stopPrice, s.qty]);
    return {
      seq: this.seq,
      lastPrice: this.lastPrice,
      halted: this.halted,
      bids: dump(this.bids),
      asks: dump(this.asks),
      buyStops: stops(this.buyStops),
      sellStops: stops(this.sellStops),
    };
  }

  /** Every resting order (used by the engine service on restart to report state). */
  *restingOrders(): Generator<{
    orderId: number;
    accountId: number;
    side: Side;
    price: number;
    qty: number;
  }> {
    for (const o of this.orders.values())
      yield { orderId: o.orderId, accountId: o.accountId, side: o.side, price: o.price, qty: o.qty };
  }
}
