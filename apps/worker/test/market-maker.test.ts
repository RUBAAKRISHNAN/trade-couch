import { describe, expect, it } from 'vitest';
import { computeQuotes, type MakerConfig } from '../src/bots/market-maker';

const cfg: MakerConfig = {
  accountId: 1,
  symbol: 'BTC-INR',
  spreadBps: 10,
  levels: 5,
  levelStepBps: 5,
  sizeUnits: 10,
  maxInventoryUnits: 1000,
  targetInventoryUnits: 2000,
  tickSizePaise: 10_000,
  lotSizeUnits: 1,
};
const REF = 7_150_000_00;

describe('market maker quotes', () => {
  it('quotes a ladder around the reference price, on the tick grid, never crossed', () => {
    const q = computeQuotes(cfg, REF, 2000, 2000);
    const bids = q.filter((x) => x.side === 'BUY').map((x) => x.price);
    const asks = q.filter((x) => x.side === 'SELL').map((x) => x.price);
    expect(bids).toHaveLength(5);
    expect(asks).toHaveLength(5);
    expect(Math.max(...bids)).toBeLessThan(REF);
    expect(Math.min(...asks)).toBeGreaterThan(REF);
    for (const p of [...bids, ...asks]) expect(p % cfg.tickSizePaise).toBe(0);
    // best bid/ask about ±5 bps (half the 10 bps spread)
    expect((REF - Math.max(...bids)) / REF).toBeLessThan(0.0007);
  });

  it('skews quotes down when long and stops bidding past the inventory limit', () => {
    const neutral = computeQuotes(cfg, REF, 2000, 2000);
    const long = computeQuotes(cfg, REF, 2800, 2800);
    const bestAsk = (q: typeof neutral) =>
      Math.min(...q.filter((x) => x.side === 'SELL').map((x) => x.price));
    expect(bestAsk(long)).toBeLessThan(bestAsk(neutral));
    const maxed = computeQuotes(cfg, REF, 3000, 3000);
    expect(maxed.filter((x) => x.side === 'BUY')).toHaveLength(0);
  });

  it('never offers more units than it has free', () => {
    const q = computeQuotes(cfg, REF, 2000, 15);
    const offered = q.filter((x) => x.side === 'SELL').reduce((a, x) => a + x.qty, 0);
    expect(offered).toBeLessThanOrEqual(15);
  });
});
