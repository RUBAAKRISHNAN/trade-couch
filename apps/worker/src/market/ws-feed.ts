import { backoffMs, type FeedState, type MarketDataProvider, type Tick } from './provider';

/** Shared reconnect/backoff/watchdog logic for WebSocket feeds (Node 22's built-in WebSocket). */
export abstract class WebSocketFeed implements MarketDataProvider {
  abstract readonly name: string;
  protected abstract url: string;
  protected abstract subscribeMessages(productIds: string[]): unknown[];
  /** Parse one raw message into (product, price) pairs. */
  protected abstract parse(msg: unknown): { product: string; price: number; ts?: number }[];

  private ws: WebSocket | undefined;
  private st: FeedState = 'stopped';
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private lastMessageAt = 0;
  private symbolByProduct = new Map<string, string>();
  private onTick: (t: Tick) => void = () => {};
  /** A connection that goes silent this long is treated as dead and recycled. */
  protected silenceMs = 15_000;

  start(products: Map<string, string>, onTick: (t: Tick) => void) {
    this.onTick = onTick;
    this.symbolByProduct = new Map([...products].map(([sym, prod]) => [prod, sym]));
    this.st = 'connecting';
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.st === 'live' && Date.now() - this.lastMessageAt > this.silenceMs) this.ws?.close();
    }, 5000);
  }

  private connect() {
    if (this.st === 'stopped') return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.st = 'live';
      this.lastMessageAt = Date.now();
      for (const m of this.subscribeMessages([...this.symbolByProduct.keys()])) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      for (const t of this.parse(data)) {
        const symbol = this.symbolByProduct.get(t.product);
        if (symbol && Number.isFinite(t.price) && t.price > 0)
          this.onTick({ symbol, price: t.price, currency: 'USD', source: this.name, ts: t.ts ?? Date.now() });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.st !== 'stopped') this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    this.st = 'reconnecting';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), backoffMs(this.attempt++));
  }

  stop() {
    this.st = 'stopped';
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    this.ws?.close();
  }

  state() {
    return this.st;
  }
}
