import {
  holdFor,
  notional,
  protectionPrice,
  type AmendCommand,
  type CancelCommand,
  type EngineCommand,
  type NewOrderCommand,
  type OrderType,
  type PlaceOrderInput,
  type Side,
  type TimeInForce,
} from '@tradecore/shared';
import { withTx, type Pool, type PoolClient } from '@tradecore/shared/node';
import { AppError } from '../errors';
import { getInstrumentRow, type InstrumentRow } from './instruments';

/** Delivers engine commands (Redis stream in production; direct call in tests). */
export interface CommandBus {
  send(symbol: string, cmd: EngineCommand): Promise<void>;
}

export interface OrderRow {
  id: number;
  account_id: number;
  symbol: string;
  client_order_id: string | null;
  side: Side;
  type: OrderType;
  tif: TimeInForce;
  qty_units: number;
  filled_units: number;
  price_paise: number | null;
  stop_price_paise: number | null;
  protect_price_paise: number | null;
  hold_price_paise: number | null;
  held_cash_paise: number;
  held_units: number;
  filled_notional_paise: number;
  status: string;
  reason: string | null;
  plan_stop_paise: number | null;
  plan_target_paise: number | null;
  amend_pending: boolean;
  amend_reserve_paise: number;
  amend_reserve_units: number;
  is_bot: boolean;
  created_at: Date;
  updated_at: Date;
}

const OPEN = `('PENDING','OPEN','PARTIALLY_FILLED')`;

async function refPrice(c: PoolClient, symbol: string): Promise<number | undefined> {
  const r = await c.query<{ p: number | null }>(
    'SELECT COALESCE(ref_price_paise, last_price_paise) AS p FROM market_prices WHERE symbol = $1',
    [symbol],
  );
  return r.rows[0]?.p ?? undefined;
}

function checkSteps(inst: InstrumentRow, input: { qty: number; price?: number; stopPrice?: number }) {
  if (input.qty % inst.lot_size_units !== 0)
    throw new AppError(
      400,
      'BAD_QTY',
      `Quantity must be a multiple of the lot size (${inst.lot_size_units} units)`,
    );
  for (const [k, v] of [
    ['price', input.price],
    ['stopPrice', input.stopPrice],
  ] as const)
    if (v !== undefined && v % inst.tick_size_paise !== 0)
      throw new AppError(
        400,
        'BAD_TICK',
        `${k} must be a multiple of the tick size (${inst.tick_size_paise} paise)`,
      );
}

/**
 * Pre-trade risk + order creation, in ONE transaction:
 *   lock account (and holding) → check available balance → reserve the hold → insert order (PENDING).
 * Only after COMMIT is the command sent to the engine. If sending fails, the order is rejected and the
 * hold released, so money is never stuck.
 */
export async function placeOrder(
  pool: Pool,
  bus: CommandBus,
  accountId: number,
  input: PlaceOrderInput,
  opts: { isBot?: boolean; now?: number } = {},
): Promise<OrderRow> {
  const inst = await getInstrumentRow(pool, input.symbol);
  if (inst.status !== 'ACTIVE')
    throw new AppError(409, 'HALTED', `${inst.symbol} is ${inst.status.toLowerCase()}`);
  checkSteps(inst, input);
  const isMarket = input.type === 'MARKET' || input.type === 'STOP_MARKET';
  const tif: TimeInForce = input.tif ?? (isMarket ? 'IOC' : 'GTC');
  if (isMarket && tif === 'GTC') throw new AppError(400, 'BAD_PARAMS', 'Market orders must be IOC or FOK');

  const order = await withTx(pool, async (c) => {
    const acct = await c.query<{ cash_paise: number; cash_held_paise: number }>(
      'SELECT cash_paise, cash_held_paise FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId],
    );
    if (!acct.rows[0]) throw new AppError(404, 'NO_ACCOUNT', 'Account not found');

    let protectPrice: number | undefined;
    if (isMarket) {
      // Market orders are "market with protection": worst price = reference ± band (or stop ± band).
      const base = input.type === 'STOP_MARKET' ? input.stopPrice! : await refPrice(c, inst.symbol);
      if (base === undefined)
        throw new AppError(409, 'NO_PRICE', 'No reference price yet — try again in a moment');
      protectPrice = protectionPrice(input.side, base, inst.price_band_bps, inst.tick_size_paise);
    }
    const hold = holdFor(
      { side: input.side, type: input.type, qty: input.qty, price: input.price, protectPrice },
      inst.qty_scale,
    );

    if (hold.cash > 0) {
      const avail = acct.rows[0].cash_paise - acct.rows[0].cash_held_paise;
      if (hold.cash > avail)
        throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Not enough available cash for this order', {
          needed: hold.cash,
          available: avail,
        });
      await c.query('UPDATE accounts SET cash_held_paise = cash_held_paise + $2 WHERE id = $1', [
        accountId,
        hold.cash,
      ]);
    }
    if (hold.units > 0) {
      const h = await c.query<{ qty_units: number; qty_held_units: number }>(
        'SELECT qty_units, qty_held_units FROM holdings WHERE account_id = $1 AND symbol = $2 FOR UPDATE',
        [accountId, inst.symbol],
      );
      const avail = h.rows[0] ? h.rows[0].qty_units - h.rows[0].qty_held_units : 0;
      if (hold.units > avail)
        throw new AppError(
          422,
          'INSUFFICIENT_QTY',
          `You can sell at most ${avail} units (no short selling)`,
          {
            needed: hold.units,
            available: avail,
          },
        );
      await c.query(
        'UPDATE holdings SET qty_held_units = qty_held_units + $3, updated_at = now() WHERE account_id = $1 AND symbol = $2',
        [accountId, inst.symbol, hold.units],
      );
    }
    try {
      const r = await c.query<OrderRow>(
        `INSERT INTO orders (account_id, symbol, client_order_id, side, type, tif, qty_units, price_paise,
            stop_price_paise, protect_price_paise, hold_price_paise, held_cash_paise, held_units,
            plan_stop_paise, plan_target_paise, is_bot, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, to_timestamp($17/1000.0), to_timestamp($17/1000.0))
         RETURNING *`,
        [
          accountId,
          inst.symbol,
          input.clientOrderId ?? null,
          input.side,
          input.type,
          tif,
          input.qty,
          input.price ?? null,
          input.stopPrice ?? null,
          protectPrice ?? null,
          input.side === 'BUY' ? (input.price ?? protectPrice) : null,
          hold.cash,
          hold.units,
          input.planStopPrice ?? null,
          input.planTargetPrice ?? null,
          opts.isBot ?? false,
          opts.now ?? Date.now(),
        ],
      );
      return r.rows[0]!;
    } catch (e) {
      if ((e as { constraint?: string }).constraint === 'unique_client_order_id')
        throw new AppError(409, 'DUPLICATE_CLIENT_ORDER_ID', 'clientOrderId already used');
      throw e;
    }
  });

  const cmd: NewOrderCommand = {
    kind: 'NEW',
    orderId: order.id,
    accountId,
    side: order.side,
    type: order.type,
    tif: order.tif,
    qty: order.qty_units,
    price: order.price_paise ?? undefined,
    stopPrice: order.stop_price_paise ?? undefined,
    protectPrice: order.protect_price_paise ?? undefined,
    ts: opts.now ?? Date.now(),
  };
  try {
    await bus.send(inst.symbol, cmd);
  } catch (e) {
    await failPendingOrder(pool, order.id, 'ENGINE_UNAVAILABLE');
    throw new AppError(
      503,
      'ENGINE_UNAVAILABLE',
      'Matching engine unavailable, order not placed',
      undefined,
      e,
    );
  }
  return order;
}

/** Compensation when a command could not be delivered: reject the PENDING order and release its hold. */
async function failPendingOrder(pool: Pool, orderId: number, reason: string) {
  await withTx(pool, async (c) => {
    const o = (await c.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    if (!o || o.status !== 'PENDING') return;
    await c.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [o.account_id]);
    if (o.held_units > 0)
      await c.query('SELECT 1 FROM holdings WHERE account_id = $1 AND symbol = $2 FOR UPDATE', [
        o.account_id,
        o.symbol,
      ]);
    await c.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    await c.query('UPDATE accounts SET cash_held_paise = cash_held_paise - $2 WHERE id = $1', [
      o.account_id,
      o.held_cash_paise,
    ]);
    if (o.held_units > 0)
      await c.query(
        'UPDATE holdings SET qty_held_units = qty_held_units - $3 WHERE account_id = $1 AND symbol = $2',
        [o.account_id, o.symbol, o.held_units],
      );
    await c.query(
      `UPDATE orders SET status = 'REJECTED', reason = $2, held_cash_paise = 0, held_units = 0, updated_at = now() WHERE id = $1`,
      [orderId, reason],
    );
  });
}

async function loadOwnOpenOrder(pool: Pool, accountIds: number[], orderId: number): Promise<OrderRow> {
  const r = await pool.query<OrderRow>(
    `SELECT * FROM orders WHERE id = $1 AND account_id = ANY($2::bigint[])`,
    [orderId, accountIds],
  );
  const o = r.rows[0];
  if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  if (!['PENDING', 'OPEN', 'PARTIALLY_FILLED'].includes(o.status))
    throw new AppError(409, 'NOT_OPEN', `Order is already ${o.status.toLowerCase()}`);
  return o;
}

/** Cancel is a request: the engine decides (the order may fill first). The CANCELLED event releases the hold. */
export async function requestCancel(
  pool: Pool,
  bus: CommandBus,
  accountIds: number[],
  orderId: number,
): Promise<OrderRow> {
  const o = await loadOwnOpenOrder(pool, accountIds, orderId);
  const cmd: CancelCommand = { kind: 'CANCEL', orderId: o.id, accountId: o.account_id, ts: Date.now() };
  await bus.send(o.symbol, cmd);
  return o;
}

/**
 * Amend a resting limit order. If the new terms need a bigger hold (higher buy price or more qty),
 * reserve the difference now, under locks, before the engine sees the amend.
 */
export async function requestAmend(
  pool: Pool,
  bus: CommandBus,
  accountIds: number[],
  orderId: number,
  change: { qty?: number; price?: number },
): Promise<OrderRow> {
  const pre = await loadOwnOpenOrder(pool, accountIds, orderId);
  if (pre.type !== 'LIMIT' || pre.tif !== 'GTC')
    throw new AppError(400, 'NOT_AMENDABLE', 'Only resting GTC limit orders can be amended');
  const inst = await getInstrumentRow(pool, pre.symbol);
  const openQty = pre.qty_units - pre.filled_units;
  const newQty = change.qty ?? openQty; // new OPEN quantity
  const newPrice = change.price ?? pre.price_paise!;
  checkSteps(inst, { qty: newQty, price: newPrice });

  await withTx(pool, async (c) => {
    await c.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [pre.account_id]);
    if (pre.side === 'SELL')
      await c.query('SELECT 1 FROM holdings WHERE account_id = $1 AND symbol = $2 FOR UPDATE', [
        pre.account_id,
        pre.symbol,
      ]);
    const o = (await c.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0]!;
    if (o.amend_pending) throw new AppError(409, 'AMEND_PENDING', 'Previous amend still in progress');
    if (!['PENDING', 'OPEN', 'PARTIALLY_FILLED'].includes(o.status))
      throw new AppError(409, 'NOT_OPEN', 'Order closed');
    let extraCash = 0;
    let extraUnits = 0;
    if (o.side === 'BUY') {
      extraCash = Math.max(0, notional(newPrice, newQty, inst.qty_scale) - o.held_cash_paise);
      if (extraCash > 0) {
        const r = await c.query(
          'UPDATE accounts SET cash_held_paise = cash_held_paise + $2 WHERE id = $1 AND cash_paise - cash_held_paise >= $2',
          [o.account_id, extraCash],
        );
        if (r.rowCount === 0)
          throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Not enough available cash for this amend');
      }
    } else {
      extraUnits = Math.max(0, newQty - o.held_units);
      if (extraUnits > 0) {
        const r = await c.query(
          `UPDATE holdings SET qty_held_units = qty_held_units + $3
           WHERE account_id = $1 AND symbol = $2 AND qty_units - qty_held_units >= $3`,
          [o.account_id, o.symbol, extraUnits],
        );
        if (r.rowCount === 0) throw new AppError(422, 'INSUFFICIENT_QTY', 'Not enough units for this amend');
      }
    }
    await c.query(
      `UPDATE orders SET amend_pending = true, amend_reserve_paise = $2, amend_reserve_units = $3,
         held_cash_paise = held_cash_paise + $2, held_units = held_units + $3, updated_at = now() WHERE id = $1`,
      [orderId, extraCash, extraUnits],
    );
  });
  const cmd: AmendCommand = {
    kind: 'AMEND',
    orderId,
    accountId: pre.account_id,
    newQty: change.qty,
    newPrice: change.price,
    ts: Date.now(),
  };
  try {
    await bus.send(pre.symbol, cmd);
  } catch (e) {
    await revertAmend(pool, orderId);
    throw new AppError(
      503,
      'ENGINE_UNAVAILABLE',
      'Matching engine unavailable, amend not sent',
      undefined,
      e,
    );
  }
  return pre;
}

/** The amend never reached the engine: give back the extra reservation. */
async function revertAmend(pool: Pool, orderId: number) {
  await withTx(pool, async (c) => {
    const o = (await c.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    if (!o?.amend_pending) return;
    await c.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [o.account_id]);
    if (o.amend_reserve_units > 0)
      await c.query('SELECT 1 FROM holdings WHERE account_id = $1 AND symbol = $2 FOR UPDATE', [
        o.account_id,
        o.symbol,
      ]);
    await c.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    await c.query('UPDATE accounts SET cash_held_paise = cash_held_paise - $2 WHERE id = $1', [
      o.account_id,
      o.amend_reserve_paise,
    ]);
    if (o.amend_reserve_units > 0)
      await c.query(
        'UPDATE holdings SET qty_held_units = qty_held_units - $3 WHERE account_id = $1 AND symbol = $2',
        [o.account_id, o.symbol, o.amend_reserve_units],
      );
    await c.query(
      `UPDATE orders SET held_cash_paise = held_cash_paise - amend_reserve_paise, held_units = held_units - amend_reserve_units,
         amend_reserve_paise = 0, amend_reserve_units = 0, amend_pending = false, updated_at = now() WHERE id = $1`,
      [orderId],
    );
  });
}

export const OPEN_STATUSES = OPEN;
