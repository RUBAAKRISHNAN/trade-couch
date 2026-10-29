import type { FeedState, MarketDataProvider, Tick } from './provider';

/** Deterministic PRNG (mulberry32) → reproducible price paths for tests and demos. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box–Muller. */
export function gaussian(rand: () => number) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const YEAR_MS = 365 * 24 * 3600 * 1000;

/**
 * Geometric Brownian motion: S(t+dt) = S(t) · exp((μ − σ²/2)·dt + σ·√dt·Z), Z ~ N(0,1).
 * Prices stay positive and move in percentage terms, like real assets. σ is annualised volatility.
 */
export class GbmPath {
  constructor(
    public price: number,
    private sigma: number,
    private rand: () => number,
    private mu = 0,
  ) {}
  step(dtMs: number): number {
    const dt = dtMs / YEAR_MS;
    this.price *= Math.exp(
      (this.mu - (this.sigma * this.sigma) / 2) * dt + this.sigma * Math.sqrt(dt) * gaussian(this.rand),
    );
    return this.price;
  }
}

export interface SimSpec {
  start: number;
  sigma: number;
  currency: 'USD' | 'INR';
}

/** Offline feed: one seeded GBM path per symbol, ticking every `intervalMs`. */
export class SimulatedFeed implements MarketDataProvider {
  readonly name = 'simulated';
  private paths = new Map<string, GbmPath>();
  private timer: NodeJS.Timeout | undefined;
  private st: FeedState = 'stopped';

  constructor(
    private specs: Map<string, SimSpec>,
    private seed = 42,
    private intervalMs = 500,
  ) {
    let i = 0;
    for (const [sym, s] of specs) this.paths.set(sym, new GbmPath(s.start, s.sigma, mulberry32(seed + i++)));
  }

  /** Continue a path from a real price, so a failover from a live feed doesn't make the price jump. */
  reanchor(symbol: string, price: number) {
    const p = this.paths.get(symbol);
    if (p) p.price = price;
  }

  start(_products: Map<string, string>, onTick: (t: Tick) => void) {
    this.st = 'live';
    this.timer = setInterval(() => {
      for (const [sym, p] of this.paths)
        onTick({
          symbol: sym,
          price: p.step(this.intervalMs),
          currency: this.specs.get(sym)!.currency,
          source: this.name,
          ts: Date.now(),
        });
    }, this.intervalMs);
  }
  stop() {
    this.st = 'stopped';
    clearInterval(this.timer);
  }
  state() {
    return this.st;
  }
}
