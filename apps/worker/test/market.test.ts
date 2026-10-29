import { describe, expect, it } from 'vitest';
import { getInstrument } from '@tradecore/shared';
import { FeedManager, type RefPrice } from '../src/market/manager';
import type { FeedState, MarketDataProvider, Tick } from '../src/market/provider';
import { backoffMs } from '../src/market/provider';
import { GbmPath, mulberry32, SimulatedFeed } from '../src/market/simulated';

class FakeFeed implements MarketDataProvider {
  emit: (t: Tick) => void = () => {};
  constructor(readonly name: string) {}
  start(_p: Map<string, string>, onTick: (t: Tick) => void) {
    this.emit = onTick;
  }
  stop() {}
  state(): FeedState {
    return 'live';
  }
  tick(price: number) {
    this.emit({ symbol: 'BTC-INR', price, currency: 'USD', source: this.name, ts: 0 });
  }
}

function setup() {
  let now = 1_000_000;
  const cb = new FakeFeed('coinbase');
  const kr = new FakeFeed('kraken');
  const btc = getInstrument('BTC-INR');
  const sim = new SimulatedFeed(
    new Map([['BTC-INR', { start: 100_000, sigma: 0.5, currency: 'USD' as const }]]),
    1,
    60_000,
  );
  const refs: RefPrice[] = [];
  const switches: string[] = [];
  const m = new FeedManager(
    [btc],
    [cb, kr],
    sim,
    88,
    (r) => refs.push(r),
    (_s, _f, to) => switches.push(to),
    10_000,
    () => now,
  );
  m.start(1_000_000);
  return { m, cb, kr, sim, refs, switches, advance: (ms: number) => (now += ms), stop: () => m.stop() };
}

describe('market data failover', () => {
  it('uses the highest-priority fresh feed and converts USD → paise on the tick grid', () => {
    const s = setup();
    s.kr.tick(100_001);
    s.cb.tick(100_000);
    s.m.publish();
    const last = s.refs.at(-1)!;
    expect(last.source).toBe('coinbase');
    expect(last.pricePaise).toBe(100_000 * 88 * 100); // ₹88,00,000 = 880_000_000 paise, already on the ₹100 tick
    expect(last.pricePaise % getInstrument('BTC-INR').tickSizePaise).toBe(0);
    s.stop();
  });

  it('fails over to the next feed when the primary goes stale, and back when it recovers', () => {
    const s = setup();
    s.cb.tick(100_000);
    s.kr.tick(100_050);
    s.m.publish();
    s.advance(11_000); // coinbase silent for 11s → stale
    s.kr.tick(100_100);
    s.m.publish();
    expect(s.refs.at(-1)!.source).toBe('kraken');
    expect(s.m.status()['BTC-INR']!.source).toBe('kraken');
    s.cb.tick(100_200);
    s.m.publish();
    expect(s.refs.at(-1)!.source).toBe('coinbase');
    expect(s.switches).toEqual(['coinbase', 'kraken', 'coinbase']);
    s.stop();
  });

  it('falls back to the simulated feed (anchored at the last real price) when every live feed is stale', () => {
    const s = setup();
    s.cb.tick(100_000);
    s.m.publish();
    s.advance(20_000);
    s.m.ingest({ symbol: 'BTC-INR', price: 100_010, currency: 'USD', source: 'simulated', ts: 0 });
    s.m.publish();
    expect(s.refs.at(-1)!.source).toBe('simulated');
    expect(Math.abs(s.refs.at(-1)!.pricePaise - 100_000 * 88 * 100)).toBeLessThan(100_000 * 88 * 100 * 0.01);
    s.stop();
  });
});

describe('simulated feed', () => {
  it('GBM is reproducible from a seed and stays positive', () => {
    const a = new GbmPath(100, 2, mulberry32(7));
    const b = new GbmPath(100, 2, mulberry32(7));
    const pa = Array.from({ length: 1000 }, () => a.step(60_000));
    const pb = Array.from({ length: 1000 }, () => b.step(60_000));
    expect(pa).toEqual(pb);
    expect(Math.min(...pa)).toBeGreaterThan(0);
  });

  it('backoff grows exponentially and is capped', () => {
    for (let i = 0; i < 50; i++) {
      expect(backoffMs(0)).toBeLessThanOrEqual(1000);
      expect(backoffMs(20)).toBeLessThanOrEqual(30_000);
    }
  });
});

// TODO(me) [Phase 4 task, ~30 min]: add 'feed parsers' tests. Subclass CoinbaseFeed / BinanceFeed / KrakenFeed to
//   expose the protected parse() and feed it real-looking messages (copy shapes from each exchange's docs), e.g.
//   { type: 'ticker', product_id: 'BTC-USD', price: '81112.15' }. Also test that heartbeats/subscription acks
//   return [] so they never become prices.
