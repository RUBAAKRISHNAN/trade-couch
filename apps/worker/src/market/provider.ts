/** A price tick from a feed, in the feed's quote currency (USD for live crypto, INR for simulated instruments). */
export interface Tick {
  /** instrument symbol in TradeCore terms, e.g. BTC-INR */
  symbol: string;
  /** price as a float in `currency`; converted to integer paise downstream */
  price: number;
  currency: 'USD' | 'INR';
  source: string;
  ts: number;
}

export type FeedState = 'connecting' | 'live' | 'reconnecting' | 'stopped';

/**
 * A source of reference prices. Implementations: CoinbaseFeed, KrakenFeed (live public WebSockets)
 * and SimulatedFeed (seeded geometric Brownian motion, works offline).
 */
export interface MarketDataProvider {
  readonly name: string;
  /** products: TradeCore symbol → provider-specific product id */
  start(products: Map<string, string>, onTick: (t: Tick) => void): void;
  stop(): void;
  state(): FeedState;
}

/** Exponential backoff with full jitter: up to 1s, 2s, 4s … capped at 30s. */
export function backoffMs(attempt: number, base = 1000, cap = 30_000): number {
  return Math.round(Math.random() * Math.min(cap, base * 2 ** attempt));
}
