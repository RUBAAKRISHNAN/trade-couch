export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'STOP_LIMIT';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

/** Commands flow API → engine. Ids are assigned by Postgres before the order reaches the engine. */
export interface NewOrderCommand {
  kind: 'NEW';
  orderId: number;
  accountId: number;
  side: Side;
  type: OrderType;
  tif: TimeInForce;
  qty: number;
  /** LIMIT / STOP_LIMIT: limit price (paise). */
  price?: number;
  /** STOP_*: trigger price (paise). */
  stopPrice?: number;
  /**
   * MARKET / STOP_MARKET: worst price the order may trade at ("market order with protection").
   * The API sets it from the reference price ± the price band, and holds cash against it,
   * so a market buy can never spend more than was reserved.
   */
  protectPrice?: number;
  ts: number;
}
export interface CancelCommand {
  kind: 'CANCEL';
  orderId: number;
  accountId: number;
  ts: number;
}
/** Amend: reducing qty keeps time priority; changing price loses it (it is a cancel/replace). */
export interface AmendCommand {
  kind: 'AMEND';
  orderId: number;
  accountId: number;
  newQty?: number;
  newPrice?: number;
  ts: number;
}
/** Reference ("mark") price update from the market-data feed. Used for price bands and stop triggers. */
export interface MarkCommand {
  kind: 'MARK';
  price: number;
  ts: number;
}
export interface HaltCommand {
  kind: 'HALT' | 'RESUME';
  ts: number;
}
export type EngineCommand = NewOrderCommand | CancelCommand | AmendCommand | MarkCommand | HaltCommand;

export type CancelReason =
  'USER' | 'IOC_REMAINDER' | 'FOK_UNFILLABLE' | 'SELF_TRADE' | 'NO_LIQUIDITY' | 'HALTED';

export type RejectReason =
  | 'HALTED'
  | 'BAD_QTY'
  | 'BAD_TICK'
  | 'PRICE_BAND'
  | 'UNKNOWN_ORDER'
  | 'DUPLICATE_ORDER'
  | 'NOT_OWNER'
  | 'BAD_PARAMS';

interface EventBase {
  seq: number;
  symbol: string;
  ts: number;
}
export interface AcceptedEvent extends EventBase {
  type: 'ACCEPTED';
  order: {
    orderId: number;
    accountId: number;
    side: Side;
    type: OrderType;
    tif: TimeInForce;
    qty: number;
    price?: number;
    stopPrice?: number;
    protectPrice?: number;
    ts: number;
  };
}
export interface RejectedEvent extends EventBase {
  type: 'REJECTED';
  orderId: number;
  accountId: number;
  reason: RejectReason;
  /** true when the reject concerns a NEW order (its reservation must be released). */
  isNew: boolean;
}
export interface TradeEvent extends EventBase {
  type: 'TRADE';
  price: number;
  qty: number;
  makerOrderId: number;
  takerOrderId: number;
  buyOrderId: number;
  sellOrderId: number;
  buyAccountId: number;
  sellAccountId: number;
  aggressor: Side;
  makerRemaining: number;
  takerRemaining: number;
}
export interface CancelledEvent extends EventBase {
  type: 'CANCELLED';
  orderId: number;
  accountId: number;
  remainingQty: number;
  reason: CancelReason;
}
export interface AmendedEvent extends EventBase {
  type: 'AMENDED';
  orderId: number;
  accountId: number;
  newQty: number;
  newPrice?: number;
  lostPriority: boolean;
}
export interface StopTriggeredEvent extends EventBase {
  type: 'STOP_TRIGGERED';
  orderId: number;
  accountId: number;
  triggerPrice: number;
}
export interface HaltEvent extends EventBase {
  type: 'HALTED' | 'RESUMED';
}
export type EngineEvent =
  AcceptedEvent | RejectedEvent | TradeEvent | CancelledEvent | AmendedEvent | StopTriggeredEvent | HaltEvent;

export interface BookLevel {
  price: number;
  qty: number;
  orders: number;
}
export interface BookSnapshot {
  symbol: string;
  seq: number;
  bids: BookLevel[];
  asks: BookLevel[];
  lastPrice?: number;
  markPrice?: number;
  halted: boolean;
  ts: number;
}
