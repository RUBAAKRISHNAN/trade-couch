import { WebSocketFeed } from './ws-feed';

/** Kraken WebSocket v2 public "ticker" channel. No API key needed. */
export class KrakenFeed extends WebSocketFeed {
  readonly name = 'kraken';
  protected url = 'wss://ws.kraken.com/v2';
  protected subscribeMessages(productIds: string[]) {
    return [{ method: 'subscribe', params: { channel: 'ticker', symbol: productIds } }];
  }
  protected parse(msg: unknown) {
    const m = msg as { channel?: string; data?: { symbol: string; last: number }[] };
    if (m.channel !== 'ticker' || !Array.isArray(m.data)) return [];
    return m.data.map((d) => ({ product: d.symbol, price: Number(d.last) }));
  }
}
