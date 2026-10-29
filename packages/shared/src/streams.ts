/** Redis stream / channel names shared by api, engine and worker. */
export const streams = {
  /** API → engine: order commands for one symbol (one consumer: that symbol's engine thread). */
  commands: (symbol: string) => `tc:cmd:${symbol}`,
  /** engine → settler: the ordered event log for one symbol. */
  events: (symbol: string) => `tc:evt:${symbol}`,
};
export const channels = {
  /** engine → api (pub/sub): throttled book snapshots for websocket fan-out. */
  book: (symbol: string) => `tc:book:${symbol}`,
  /** feed → engine/bots/api (pub/sub): reference price updates. */
  ref: (symbol: string) => `tc:ref:${symbol}`,
  /** settler → api: per-account updates (orders, balances) to push to that user. */
  account: 'tc:account',
  /** settler → api: public trades after settlement. */
  trades: (symbol: string) => `tc:trades:${symbol}`,
  /** engine/feed status heartbeat */
  health: 'tc:health',
};
export const SETTLER_GROUP = 'settler';
export const ENGINE_GROUP = 'engine';
