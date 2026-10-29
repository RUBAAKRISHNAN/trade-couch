import { WebSocketFeed } from './ws-feed';

/**
 * Binance public market-data stream (trades). No API key needed.
 * Quotes are in USDT, a dollar stablecoin; we treat 1 USDT ≈ 1 USD (documented in DECISIONS.md).
 */
export class BinanceFeed extends WebSocketFeed {
  readonly name = 'binance';
  protected url = 'wss://data-stream.binance.vision/ws';
  protected subscribeMessages(productIds: string[]) {
    return [{ method: 'SUBSCRIBE', params: productIds.map((p) => `${p}@trade`), id: 1 }];
  }
  protected parse(msg: unknown) {
    const m = msg as { e?: string; s?: string; p?: string; T?: number };
    if (m.e !== 'trade' || !m.s || !m.p) return [];
    return [{ product: m.s.toLowerCase(), price: Number(m.p), ts: m.T }];
  }
}
