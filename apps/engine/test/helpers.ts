import type { EngineEvent, NewOrderCommand, OrderType, Side, TimeInForce } from '@tradecore/shared';
import { OrderBook, type BookConfig } from '../src';

export const cfg: BookConfig = { symbol: 'TEST', tickSizePaise: 100, lotSizeUnits: 1, priceBandBps: 1000 };

let nextId = 1;
export function resetIds() {
  nextId = 1;
}
export function order(
  accountId: number,
  side: Side,
  qty: number,
  price?: number,
  opts: Partial<{
    type: OrderType;
    tif: TimeInForce;
    stopPrice: number;
    protectPrice: number;
    orderId: number;
  }> = {},
): NewOrderCommand {
  const type = opts.type ?? (price === undefined ? 'MARKET' : 'LIMIT');
  return {
    kind: 'NEW',
    orderId: opts.orderId ?? nextId++,
    accountId,
    side,
    type,
    tif: opts.tif ?? (type === 'MARKET' || type === 'STOP_MARKET' ? 'IOC' : 'GTC'),
    qty,
    price,
    stopPrice: opts.stopPrice,
    protectPrice: opts.protectPrice,
    ts: 1_700_000_000_000 + nextId,
  };
}
export function trades(evs: EngineEvent[]) {
  return evs.filter((e) => e.type === 'TRADE');
}
export function newBook() {
  resetIds();
  return new OrderBook(cfg);
}
