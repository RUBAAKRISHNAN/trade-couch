import type { OrderType, Side } from './engine-types';
import { notional } from './money';

/**
 * Pre-trade risk: how much must be reserved ("held") before an order may enter the book.
 * - BUY: cash = qty × the worst price it may pay (limit price, or the protection price for market/stop-market).
 * - SELL: the coins/shares themselves (qty units). No short selling.
 * The held amount can't be spent twice, so a user can never overspend, even with many open orders.
 */
export function holdFor(
  o: { side: Side; type: OrderType; qty: number; price?: number; protectPrice?: number },
  qtyScale: number,
): { cash: number; units: number } {
  if (o.side === 'SELL') return { cash: 0, units: o.qty };
  const worst = o.type === 'LIMIT' || o.type === 'STOP_LIMIT' ? o.price : o.protectPrice;
  if (worst === undefined) throw new Error('buy order needs a limit or protection price to size its hold');
  return { cash: notional(worst, o.qty, qtyScale), units: 0 };
}

/** The price a buy hold was sized at (limit or protection price). */
export function holdPrice(o: { type: OrderType; price?: number; protectPrice?: number }): number | undefined {
  return o.type === 'LIMIT' || o.type === 'STOP_LIMIT' ? o.price : o.protectPrice;
}

/** Protection price for a market order: reference ± the instrument's price band, rounded to a tick so it stays inside the band. */
export function protectionPrice(side: Side, refPrice: number, bandBps: number, tick: number): number {
  const raw = side === 'BUY' ? refPrice * (1 + bandBps / 10_000) : refPrice * (1 - bandBps / 10_000);
  const q = side === 'BUY' ? Math.floor(raw / tick) : Math.ceil(raw / tick);
  return Math.max(tick, q * tick);
}
