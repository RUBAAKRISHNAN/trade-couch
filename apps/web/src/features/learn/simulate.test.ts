import { describe, expect, it } from 'vitest';
import { positionFromRisk, simulateOrder } from './simulate';

// the quiz example: asks 2 @ ₹100 and 3 @ ₹101 (qtyScale 1)
const book = {
  asks: [
    { price: 100_00, qty: 2, orders: 1 },
    { price: 101_00, qty: 3, orders: 1 },
  ],
  bids: [
    { price: 99_00, qty: 4, orders: 2 },
    { price: 98_00, qty: 5, orders: 1 },
  ],
};

describe('simulateOrder', () => {
  it('limit buy 4 @ ₹101 fills 2 @ 100 then 2 @ 101, best price first', () => {
    const r = simulateOrder(book, 'BUY', 4, 1, 101_00);
    expect(r.fills).toEqual([
      { price: 100_00, qty: 2 },
      { price: 101_00, qty: 2 },
    ]);
    expect(r).toMatchObject({ filledQty: 4, cost: 402_00, avgPrice: 100_50, remaining: 0 });
  });

  it('a limit below the best ask does not fill and rests in the book', () => {
    expect(simulateOrder(book, 'BUY', 3, 1, 99_50)).toMatchObject({
      filledQty: 0,
      remaining: 3,
      avgPrice: null,
    });
  });

  it('a market sell walks the bids downwards; anything beyond the book is left unfilled', () => {
    const r = simulateOrder(book, 'SELL', 12, 1);
    expect(r.fills.map((f) => f.price)).toEqual([99_00, 98_00]);
    expect(r).toMatchObject({ filledQty: 9, remaining: 3 });
  });

  it('respects qtyScale (BTC: 10 000 units = 1 coin)', () => {
    const btc = { asks: [{ price: 70_00_000_00, qty: 5, orders: 1 }], bids: [] };
    expect(simulateOrder(btc, 'BUY', 5, 10_000).cost).toBe(3_500_00); // 0.0005 BTC × ₹70 lakh = ₹3,500
  });
});

describe('positionFromRisk', () => {
  it('risking 1% of ₹1,00,000 with a stop 2% below entry → a 50% position', () => {
    const r = positionFromRisk(1_00_000, 1, 100, 98)!;
    expect(r.riskAmount).toBe(1_000);
    expect(r.coins).toBe(500);
    expect(r.positionPct).toBe(50);
  });
  it('needs a stop below the entry', () => {
    expect(positionFromRisk(1_00_000, 1, 100, 101)).toBeNull();
  });
});
