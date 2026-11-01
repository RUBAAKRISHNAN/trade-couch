import type { BookLevel } from '@/stores/market';

export interface SimFill {
  price: number;
  qty: number;
}
export interface SimResult {
  fills: SimFill[];
  filledQty: number;
  /** paise, for the filled part */
  cost: number;
  avgPrice: number | null;
  /** units left over: rests in the book (limit) or is cancelled (market) */
  remaining: number;
}

/**
 * What an order WOULD do against the current book, walking the opposite side best-price-first
 * (price priority). Educational preview only; the real engine also applies time priority within a
 * level, self-trade prevention, bands, etc.
 */
export function simulateOrder(
  book: { bids: BookLevel[]; asks: BookLevel[] },
  side: 'BUY' | 'SELL',
  qtyUnits: number,
  qtyScale: number,
  limit?: number | null,
): SimResult {
  const levels = side === 'BUY' ? book.asks : book.bids; // asks ascending, bids descending
  const fills: SimFill[] = [];
  let left = qtyUnits;
  for (const l of levels) {
    if (left <= 0) break;
    if (limit != null && (side === 'BUY' ? l.price > limit : l.price < limit)) break;
    const q = Math.min(left, l.qty);
    fills.push({ price: l.price, qty: q });
    left -= q;
  }
  const filledQty = qtyUnits - left;
  const cost = fills.reduce((s, f) => s + (f.price * f.qty) / qtyScale, 0);
  return {
    fills,
    filledQty,
    cost: Math.round(cost),
    avgPrice: filledQty ? Math.round((cost * qtyScale) / filledQty) : null,
    remaining: left,
  };
}

/** Position size from risk: how many coins so that hitting the stop loses `riskPct` of equity. */
export function positionFromRisk(equity: number, riskPct: number, entry: number, stop: number) {
  if (!(entry > stop) || stop <= 0 || equity <= 0 || riskPct <= 0) return null;
  const riskAmount = (equity * riskPct) / 100;
  const coins = riskAmount / (entry - stop);
  const positionValue = coins * entry;
  return { riskAmount, coins, positionValue, positionPct: (positionValue / equity) * 100 };
}
