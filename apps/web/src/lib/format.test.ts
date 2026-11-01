import { describe, expect, it } from 'vitest';
import { inr, parsePrice, parseQty, pct, qty, signedInr, baseAsset } from './format';

describe('format helpers (money is paise, quantity is units)', () => {
  it('formats rupees with Indian digit grouping', () => {
    expect(inr(1_00_000_00)).toBe('₹1,00,000.00');
    expect(inr(71_08_600_00, { compact: true })).toBe('₹71.09 L');
    expect(inr(null)).toBe('—');
    expect(signedInr(-813)).toBe('−₹8.13');
  });
  it('converts units ↔ coins using the instrument scale', () => {
    expect(qty(3, 10_000)).toBe('0.0003');
    expect(parseQty('0.0012', 10_000)).toBe(12);
    expect(parseQty('0.00001', 10_000)).toBeNull(); // smaller than one unit
    expect(parseQty('-1', 10_000)).toBeNull();
  });
  it('parses a rupee price and snaps it to the tick', () => {
    expect(parsePrice('7108650', 10_000)).toBe(71_08_700_00);
    expect(parsePrice('abc', 100)).toBeNull();
  });
  it('signs percentages', () => {
    expect(pct(1.234)).toBe('+1.23%');
    expect(pct(-0.5)).toBe('−0.50%');
  });

  it('baseAsset names the asset, including simulated instruments', () => {
    expect(baseAsset('BTC-INR')).toBe('BTC');
    expect(baseAsset('SIM-RELIANCE')).toBe('RELIANCE');
  });
  it('pct shows no sign for values that round to zero', () => {
    expect(pct(-0.0004)).toBe('0.00%');
    expect(pct(-0.006)).toBe('−0.01%');
  });
});
