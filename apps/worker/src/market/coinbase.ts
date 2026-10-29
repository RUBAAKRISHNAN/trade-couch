import { WebSocketFeed } from './ws-feed';

/** Coinbase Exchange public "ticker" channel. No API key needed. */
export class CoinbaseFeed extends WebSocketFeed {
  readonly name = 'coinbase';
  protected url = 'wss://ws-feed.exchange.coinbase.com';
  protected subscribeMessages(productIds: string[]) {
    return [{ type: 'subscribe', product_ids: productIds, channels: ['ticker'] }];
  }
  protected parse(msg: unknown) {
    const m = msg as { type?: string; product_id?: string; price?: string; time?: string };
    if (m.type !== 'ticker' || !m.product_id || !m.price) return [];
    return [{ product: m.product_id, price: Number(m.price), ts: m.time ? Date.parse(m.time) : undefined }];
  }
}
