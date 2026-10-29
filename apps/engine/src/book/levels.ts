import type { Side } from '@tradecore/shared';

/** A resting limit order, linked into the FIFO queue of its price level. */
export interface RestingOrder {
  orderId: number;
  accountId: number;
  side: Side;
  price: number;
  /** remaining (unfilled) quantity */
  qty: number;
  tif: 'GTC';
  ts: number;
  prev: RestingOrder | null;
  next: RestingOrder | null;
  level: PriceLevel | null;
}

/**
 * All orders at one price, in arrival order (FIFO). A doubly linked list gives
 * O(1) append, O(1) pop from the head (matching) and O(1) removal from the middle (cancel).
 */
export class PriceLevel {
  head: RestingOrder | null = null;
  tail: RestingOrder | null = null;
  totalQty = 0;
  count = 0;
  constructor(readonly price: number) {}

  push(o: RestingOrder): void {
    o.level = this;
    o.prev = this.tail;
    o.next = null;
    if (this.tail) this.tail.next = o;
    else this.head = o;
    this.tail = o;
    this.totalQty += o.qty;
    this.count++;
  }

  remove(o: RestingOrder): void {
    if (o.prev) o.prev.next = o.next;
    else this.head = o.next;
    if (o.next) o.next.prev = o.prev;
    else this.tail = o.prev;
    this.totalQty -= o.qty;
    this.count--;
    o.prev = o.next = o.level = null;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }
}

/**
 * One side of the book. Prices are kept in a sorted array of keys plus a Map from price → level.
 * The key is +price for bids and −price for asks, sorted ascending, so the BEST price is always
 * the LAST element: best bid/ask is O(1), removing the best level is an O(1) pop.
 * New levels are found with binary search (O(log n)) and inserted with splice; new levels are
 * almost always near the top of the book (the end of the array), so the copy is tiny in practice.
 */
export class BookSide {
  private keys: number[] = [];
  private byPrice = new Map<number, PriceLevel>();
  constructor(readonly side: Side) {}

  private key(price: number): number {
    return this.side === 'BUY' ? price : -price;
  }

  /** index of the first key >= k */
  private lowerBound(k: number): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.keys[mid]! < k) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  best(): PriceLevel | undefined {
    const k = this.keys[this.keys.length - 1];
    return k === undefined ? undefined : this.byPrice.get(this.side === 'BUY' ? k : -k);
  }

  get(price: number): PriceLevel | undefined {
    return this.byPrice.get(price);
  }

  getOrCreate(price: number): PriceLevel {
    let lvl = this.byPrice.get(price);
    if (lvl) return lvl;
    lvl = new PriceLevel(price);
    this.byPrice.set(price, lvl);
    const k = this.key(price);
    const n = this.keys.length;
    if (n === 0 || this.keys[n - 1]! < k) this.keys.push(k);
    else this.keys.splice(this.lowerBound(k), 0, k);
    return lvl;
  }

  removeLevel(price: number): void {
    if (!this.byPrice.delete(price)) return;
    const k = this.key(price);
    const n = this.keys.length;
    if (this.keys[n - 1] === k) this.keys.pop();
    else this.keys.splice(this.lowerBound(k), 1);
  }

  get levelCount(): number {
    return this.keys.length;
  }

  /** Levels from best to worst. */
  *levels(): Generator<PriceLevel> {
    for (let i = this.keys.length - 1; i >= 0; i--) {
      const k = this.keys[i]!;
      yield this.byPrice.get(this.side === 'BUY' ? k : -k)!;
    }
  }
}
