import { notional, type EngineEvent, type TradeEvent } from '@tradecore/shared';
import type { Pool, PoolClient } from '@tradecore/shared/node';
import type { OrderRow } from './orders';

/**
 * SETTLEMENT — turns engine events into balance changes, atomically and exactly once.
 *
 * One call settles a batch of consecutive events for ONE symbol inside ONE transaction:
 *   1. lock engine_offsets(symbol) and skip events already applied (exactly-once)
 *   2. lock every account, holding and order the batch touches, in a fixed global order
 *      (accounts by id → holdings by (account, symbol) → orders by id) so two transactions can never
 *      wait on each other in a cycle (no deadlocks)
 *   3. apply the events in memory, then write everything back with bulk UPDATE/INSERTs
 *   4. advance the offset and commit. CHECK constraints (cash >= 0, held <= cash, qty >= 0 …) are the
 *      last line of defence: if any rule is broken, the whole batch rolls back.
 *
 * Isolation: READ COMMITTED + explicit row locks (SELECT … FOR UPDATE). Every row we modify is locked
 * first, so no lost updates; SERIALIZABLE would add retry storms on these hot rows for no extra safety.
 */

interface AccountState {
  id: number;
  cash_paise: number;
  cash_held_paise: number;
  dirty: boolean;
}
interface HoldingState {
  account_id: number;
  symbol: string;
  qty_units: number;
  qty_held_units: number;
  cost_basis_paise: number;
  realized_pnl_paise: number;
  dirty: boolean;
}

export interface SettleResult {
  applied: number;
  skipped: number;
  lastSeq: number;
  trades: TradeEvent[];
  /** accounts whose balances/orders changed (for websocket push) */
  accountIds: number[];
  orderIds: number[];
}

const hkey = (a: number, s: string) => `${a}|${s}`;
const isOpen = (s: string) => s === 'PENDING' || s === 'OPEN' || s === 'PARTIALLY_FILLED';

function orderIdsOf(e: EngineEvent): number[] {
  switch (e.type) {
    case 'TRADE':
      return [e.buyOrderId, e.sellOrderId];
    case 'ACCEPTED':
      return [e.order.orderId];
    case 'REJECTED':
    case 'CANCELLED':
    case 'AMENDED':
    case 'STOP_TRIGGERED':
      return [e.orderId];
    default:
      return [];
  }
}

export async function settleBatch(pool: Pool, symbol: string, events: EngineEvent[]): Promise<SettleResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const res = await settleInTx(c, symbol, events);
    await c.query('COMMIT');
    return res;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function settleInTx(c: PoolClient, symbol: string, events: EngineEvent[]): Promise<SettleResult> {
  await c.query('INSERT INTO engine_offsets(symbol) VALUES ($1) ON CONFLICT DO NOTHING', [symbol]);
  const { last_seq } = (
    await c.query<{ last_seq: number }>('SELECT last_seq FROM engine_offsets WHERE symbol = $1 FOR UPDATE', [
      symbol,
    ])
  ).rows[0]!;

  const todo = events.filter((e) => e.seq > last_seq).sort((a, b) => a.seq - b.seq);
  const result: SettleResult = {
    applied: 0,
    skipped: events.length - todo.length,
    lastSeq: last_seq,
    trades: [],
    accountIds: [],
    orderIds: [],
  };
  if (todo.length === 0) return result;
  todo.forEach((e, i) => {
    if (e.symbol !== symbol) throw new Error(`event for ${e.symbol} in ${symbol} batch`);
    if (e.seq !== last_seq + 1 + i)
      throw new Error(`settlement gap for ${symbol}: expected seq ${last_seq + 1 + i}, got ${e.seq}`);
  });

  const { qty_scale: qtyScale } = (
    await c.query<{ qty_scale: number }>('SELECT qty_scale FROM instruments WHERE symbol = $1', [symbol])
  ).rows[0]!;

  // ── 1. discover what the batch touches (plain reads, no locks yet)
  const orderIds = [...new Set(todo.flatMap(orderIdsOf))].sort((a, b) => a - b);
  const pre = (await c.query<OrderRow>('SELECT * FROM orders WHERE id = ANY($1::bigint[])', [orderIds])).rows;
  const preById = new Map(pre.map((o) => [o.id, o]));
  for (const id of orderIds) if (!preById.has(id)) throw new Error(`settlement: unknown order ${id}`);
  const accountIds = [...new Set(pre.map((o) => o.account_id))].sort((a, b) => a - b);

  // ── 2. lock in global order: accounts → holdings → orders
  const accounts = new Map<number, AccountState>();
  for (const r of (
    await c.query<AccountState>(
      'SELECT id, cash_paise, cash_held_paise FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
      [accountIds],
    )
  ).rows)
    accounts.set(r.id, { ...r, dirty: false });

  // buyers may not have a holding row yet; create empty ones (we already hold their account locks)
  await c.query(
    `INSERT INTO holdings (account_id, symbol) SELECT a, $2 FROM unnest($1::bigint[]) a ON CONFLICT DO NOTHING`,
    [accountIds, symbol],
  );
  const holdings = new Map<string, HoldingState>();
  for (const r of (
    await c.query<HoldingState>(
      `SELECT account_id, symbol, qty_units, qty_held_units, cost_basis_paise, realized_pnl_paise
       FROM holdings WHERE symbol = $2 AND account_id = ANY($1::bigint[]) ORDER BY account_id FOR UPDATE`,
      [accountIds, symbol],
    )
  ).rows)
    holdings.set(hkey(r.account_id, r.symbol), { ...r, dirty: false });

  const orders = new Map<number, OrderRow & { dirty?: boolean; triggered?: number }>();
  for (const r of (
    await c.query<OrderRow>('SELECT * FROM orders WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [
      orderIds,
    ])
  ).rows)
    orders.set(r.id, r);

  // ── 3. apply events in memory
  const acct = (id: number) => accounts.get(id)!;
  const hold = (id: number) => holdings.get(hkey(id, symbol))!;

  /** Make an order's reservation exactly what its open quantity still needs; release the rest. */
  const reconcile = (o: OrderRow) => {
    const openQty = isOpen(o.status) ? o.qty_units - o.filled_units : 0;
    const needCash =
      o.side === 'BUY' && openQty > 0
        ? notional(o.hold_price_paise!, openQty, qtyScale) + o.amend_reserve_paise
        : 0;
    const needUnits = o.side === 'SELL' && openQty > 0 ? openQty + o.amend_reserve_units : 0;
    const relCash = o.held_cash_paise - needCash;
    const relUnits = o.held_units - needUnits;
    if (relCash < 0 || relUnits < 0)
      throw new Error(`order ${o.id}: hold below requirement (${relCash}, ${relUnits})`);
    if (relCash > 0) {
      const a = acct(o.account_id);
      a.cash_held_paise -= relCash;
      a.dirty = true;
      o.held_cash_paise = needCash;
    }
    if (relUnits > 0) {
      const h = hold(o.account_id);
      h.qty_held_units -= relUnits;
      h.dirty = true;
      o.held_units = needUnits;
    }
  };
  const touch = (o: OrderRow & { dirty?: boolean }) => {
    o.dirty = true;
    reconcile(o);
  };
  const fillStatus = (o: OrderRow) =>
    o.filled_units === o.qty_units ? 'FILLED' : o.filled_units > 0 ? 'PARTIALLY_FILLED' : 'OPEN';

  const tradeRows: unknown[][] = [];
  let lastPrice: number | undefined;
  let lastTs = 0;
  let haltState: 'HALTED' | 'ACTIVE' | undefined;

  for (const e of todo) {
    lastTs = e.ts;
    switch (e.type) {
      case 'ACCEPTED': {
        const o = orders.get(e.order.orderId)!;
        if (o.status === 'PENDING') o.status = 'OPEN';
        touch(o);
        break;
      }
      case 'REJECTED': {
        const o = orders.get(e.orderId)!;
        if (e.cmd === 'NEW') {
          o.status = 'REJECTED';
          o.reason = e.reason;
        } else if (e.cmd === 'AMEND' && o.amend_pending) {
          o.amend_pending = false;
          o.amend_reserve_paise = 0;
          o.amend_reserve_units = 0;
        }
        touch(o);
        break;
      }
      case 'CANCELLED': {
        const o = orders.get(e.orderId)!;
        o.status = 'CANCELLED';
        o.reason = e.reason;
        o.amend_pending = false;
        o.amend_reserve_paise = 0;
        o.amend_reserve_units = 0;
        touch(o);
        break;
      }
      case 'AMENDED': {
        const o = orders.get(e.orderId)!;
        o.qty_units = o.filled_units + e.newQty;
        if (e.newPrice !== undefined) {
          o.price_paise = e.newPrice;
          if (o.side === 'BUY') o.hold_price_paise = e.newPrice;
        }
        o.amend_pending = false;
        o.amend_reserve_paise = 0;
        o.amend_reserve_units = 0;
        o.status = fillStatus(o);
        touch(o);
        break;
      }
      case 'STOP_TRIGGERED': {
        const o = orders.get(e.orderId)!;
        o.triggered = e.ts;
        o.dirty = true;
        break;
      }
      case 'TRADE': {
        const buy = orders.get(e.buyOrderId)!;
        const sell = orders.get(e.sellOrderId)!;
        const cost = notional(e.price, e.qty, qtyScale);
        // buyer: pays cash, receives units (cost basis grows by what was paid)
        const ba = acct(buy.account_id);
        ba.cash_paise -= cost;
        ba.dirty = true;
        const bh = hold(buy.account_id);
        bh.qty_units += e.qty;
        bh.cost_basis_paise += cost;
        bh.dirty = true;
        // seller: receives cash, delivers units; realised P&L = proceeds − average cost of the units sold
        const sa = acct(sell.account_id);
        sa.cash_paise += cost;
        sa.dirty = true;
        const sh = hold(sell.account_id);
        const removedBasis =
          e.qty === sh.qty_units
            ? sh.cost_basis_paise
            : Number((BigInt(sh.cost_basis_paise) * BigInt(e.qty)) / BigInt(sh.qty_units));
        sh.qty_units -= e.qty;
        sh.qty_held_units -= e.qty; // the units were reserved when the sell order was placed
        sell.held_units -= e.qty;
        sh.cost_basis_paise -= removedBasis;
        sh.realized_pnl_paise += cost - removedBasis;
        sh.dirty = true;
        for (const o of [buy, sell]) {
          o.filled_units += e.qty;
          o.filled_notional_paise += cost;
          o.status = fillStatus(o);
          touch(o);
        }
        tradeRows.push([
          e.seq,
          e.price,
          e.qty,
          cost,
          buy.id,
          sell.id,
          buy.account_id,
          sell.account_id,
          e.aggressor,
          e.ts,
        ]);
        result.trades.push(e);
        lastPrice = e.price;
        break;
      }
      case 'HALTED':
        haltState = 'HALTED';
        break;
      case 'RESUMED':
        haltState = 'ACTIVE';
        break;
    }
  }

  // ── 4. write back in bulk
  const dirtyAccts = [...accounts.values()].filter((a) => a.dirty);
  if (dirtyAccts.length)
    await c.query(
      `UPDATE accounts a SET cash_paise = v.cash, cash_held_paise = v.held
       FROM unnest($1::bigint[], $2::bigint[], $3::bigint[]) AS v(id, cash, held) WHERE a.id = v.id`,
      [
        dirtyAccts.map((a) => a.id),
        dirtyAccts.map((a) => a.cash_paise),
        dirtyAccts.map((a) => a.cash_held_paise),
      ],
    );
  const dirtyH = [...holdings.values()].filter((h) => h.dirty);
  if (dirtyH.length)
    await c.query(
      `UPDATE holdings h SET qty_units = v.q, qty_held_units = v.qh, cost_basis_paise = v.cb, realized_pnl_paise = v.rp, updated_at = now()
       FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[]) AS v(acct, q, qh, cb, rp)
       WHERE h.account_id = v.acct AND h.symbol = $6`,
      [
        dirtyH.map((h) => h.account_id),
        dirtyH.map((h) => h.qty_units),
        dirtyH.map((h) => h.qty_held_units),
        dirtyH.map((h) => h.cost_basis_paise),
        dirtyH.map((h) => h.realized_pnl_paise),
        symbol,
      ],
    );
  const dirtyO = [...orders.values()].filter((o) => o.dirty);
  if (dirtyO.length)
    await c.query(
      `UPDATE orders o SET status = v.status::order_status, reason = v.reason, qty_units = v.qty, filled_units = v.filled,
         filled_notional_paise = v.fnot, price_paise = v.price, hold_price_paise = v.hprice,
         held_cash_paise = v.hcash, held_units = v.hunits, amend_pending = v.ap, amend_reserve_paise = v.arp,
         amend_reserve_units = v.aru, triggered_at = COALESCE(to_timestamp(v.trig / 1000.0), o.triggered_at), updated_at = now()
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[],
                   $9::bigint[], $10::bigint[], $11::boolean[], $12::bigint[], $13::bigint[], $14::bigint[])
            AS v(id, status, reason, qty, filled, fnot, price, hprice, hcash, hunits, ap, arp, aru, trig)
       WHERE o.id = v.id`,
      [
        dirtyO.map((o) => o.id),
        dirtyO.map((o) => o.status),
        dirtyO.map((o) => o.reason),
        dirtyO.map((o) => o.qty_units),
        dirtyO.map((o) => o.filled_units),
        dirtyO.map((o) => o.filled_notional_paise),
        dirtyO.map((o) => o.price_paise),
        dirtyO.map((o) => o.hold_price_paise),
        dirtyO.map((o) => o.held_cash_paise),
        dirtyO.map((o) => o.held_units),
        dirtyO.map((o) => o.amend_pending),
        dirtyO.map((o) => o.amend_reserve_paise),
        dirtyO.map((o) => o.amend_reserve_units),
        dirtyO.map((o) => o.triggered ?? null),
      ],
    );
  if (tradeRows.length) {
    const col = (i: number) => tradeRows.map((r) => r[i]);
    await c.query(
      `INSERT INTO trades (symbol, seq, price_paise, qty_units, notional_paise, buy_order_id, sell_order_id,
          buyer_account_id, seller_account_id, aggressor, executed_at)
       SELECT $1, v.seq, v.price, v.qty, v.notional, v.b, v.s, v.ba, v.sa, v.aggr::order_side, to_timestamp(v.ts / 1000.0)
       FROM unnest($2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[],
                   $9::bigint[], $10::text[], $11::bigint[]) AS v(seq, price, qty, notional, b, s, ba, sa, aggr, ts)`,
      [symbol, ...Array.from({ length: 10 }, (_, i) => col(i))],
    );
  }
  // the append-only event log (what the engine replays after a crash)
  await c.query(
    `INSERT INTO order_events (symbol, seq, event_type, order_id, account_id, payload, created_at)
     SELECT $1, v.seq, v.t, v.oid, v.aid, v.p, to_timestamp(v.ts / 1000.0)
     FROM unnest($2::bigint[], $3::text[], $4::bigint[], $5::bigint[], $6::jsonb[], $7::bigint[]) AS v(seq, t, oid, aid, p, ts)`,
    [
      symbol,
      todo.map((e) => e.seq),
      todo.map((e) => e.type),
      todo.map((e) => orderIdsOf(e)[0] ?? null),
      todo.map((e) => {
        const id = orderIdsOf(e)[0];
        return id === undefined ? null : preById.get(id)!.account_id;
      }),
      todo.map((e) => JSON.stringify(e)),
      todo.map((e) => e.ts),
    ],
  );
  if (lastPrice !== undefined)
    await c.query(
      `INSERT INTO market_prices (symbol, last_price_paise, updated_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT (symbol) DO UPDATE SET last_price_paise = EXCLUDED.last_price_paise, updated_at = EXCLUDED.updated_at`,
      [symbol, lastPrice, lastTs],
    );
  if (haltState)
    await c.query('UPDATE instruments SET status = $2::instrument_status WHERE symbol = $1', [
      symbol,
      haltState,
    ]);
  const newSeq = todo[todo.length - 1]!.seq;
  await c.query('UPDATE engine_offsets SET last_seq = $2, updated_at = now() WHERE symbol = $1', [
    symbol,
    newSeq,
  ]);

  result.applied = todo.length;
  result.lastSeq = newSeq;
  result.accountIds = accountIds;
  result.orderIds = orderIds;
  return result;
}

/** Load the persisted event log for a symbol (used by the engine to rebuild its book on restart). */
export async function loadEventLog(pool: Pool, symbol: string, afterSeq = 0): Promise<EngineEvent[]> {
  const r = await pool.query<{ payload: EngineEvent }>(
    'SELECT payload FROM order_events WHERE symbol = $1 AND seq > $2 ORDER BY seq',
    [symbol, afterSeq],
  );
  return r.rows.map((x) => x.payload);
}
