import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../app';
import { resolveAccount } from '../lib/accounts';

const q = z.object({ competitionId: z.coerce.number().int().positive().optional() });

/**
 * Portfolio valuation. Unrealised P&L = (market price × qty) − cost basis, valued at the reference
 * price (falls back to the last trade). Equity = cash + market value of all holdings.
 */
export async function portfolioOf(pool: import('@tradecore/shared/node').Pool, accountId: number) {
  const a = (
    await pool.query(
      'SELECT id, competition_id, cash_paise, cash_held_paise, starting_cash_paise FROM accounts WHERE id = $1',
      [accountId],
    )
  ).rows[0];
  const holdings = (
    await pool.query(
      `SELECT h.symbol, i.name, i.qty_scale, h.qty_units, h.qty_held_units, h.cost_basis_paise, h.realized_pnl_paise,
              COALESCE(mp.ref_price_paise, mp.last_price_paise) AS price,
              (h.qty_units * COALESCE(mp.ref_price_paise, mp.last_price_paise, 0) / i.qty_scale) AS market_value
       FROM holdings h JOIN instruments i ON i.symbol = h.symbol LEFT JOIN market_prices mp ON mp.symbol = h.symbol
       WHERE h.account_id = $1 AND (h.qty_units > 0 OR h.realized_pnl_paise <> 0) ORDER BY market_value DESC`,
      [accountId],
    )
  ).rows.map((h) => ({
    symbol: h.symbol,
    name: h.name,
    qtyScale: h.qty_scale,
    qty: h.qty_units,
    heldQty: h.qty_held_units,
    avgCost: h.qty_units ? Math.round((h.cost_basis_paise * h.qty_scale) / h.qty_units) : null,
    costBasis: h.cost_basis_paise,
    price: h.price,
    marketValue: Number(h.market_value),
    unrealizedPnl: h.qty_units ? Number(h.market_value) - h.cost_basis_paise : 0,
    realizedPnl: h.realized_pnl_paise,
  }));
  const marketValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const equity = a.cash_paise + marketValue;
  return {
    accountId: a.id,
    competitionId: a.competition_id,
    cash: a.cash_paise,
    cashHeld: a.cash_held_paise,
    cashAvailable: a.cash_paise - a.cash_held_paise,
    startingCash: a.starting_cash_paise,
    marketValue,
    equity,
    totalPnl: equity - a.starting_cash_paise,
    totalReturnPct: ((equity - a.starting_cash_paise) / a.starting_cash_paise) * 100,
    realizedPnl: holdings.reduce((s, h) => s + h.realizedPnl, 0),
    unrealizedPnl: holdings.reduce((s, h) => s + h.unrealizedPnl, 0),
    holdings,
  };
}

export const portfolioRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool } = app.deps;
  app.addHook('preHandler', requireAuth);

  app.get('/', { schema: { tags: ['portfolio'], security: [{ bearer: [] }], querystring: q } }, async (req) =>
    portfolioOf(pool, await resolveAccount(pool, req.user!.id, req.query.competitionId)),
  );

  app.get(
    '/trades',
    {
      schema: {
        tags: ['portfolio'],
        security: [{ bearer: [] }],
        querystring: q.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      },
    },
    async (req) => {
      const acct = await resolveAccount(pool, req.user!.id, req.query.competitionId);
      const r = await pool.query(
        `SELECT t.id, t.symbol, t.price_paise AS price, t.qty_units AS qty, t.notional_paise AS notional, t.executed_at AS ts,
                CASE WHEN t.buyer_account_id = $1 THEN 'BUY' ELSE 'SELL' END AS side,
                CASE WHEN t.buyer_account_id = $1 THEN t.buy_order_id ELSE t.sell_order_id END AS order_id,
                (t.aggressor = CASE WHEN t.buyer_account_id = $1 THEN 'BUY' ELSE 'SELL' END::order_side) AS taker
         FROM trades t WHERE t.buyer_account_id = $1 OR t.seller_account_id = $1
         ORDER BY t.executed_at DESC LIMIT $2`,
        [acct, req.query.limit],
      );
      return r.rows;
    },
  );

  /** Equity curve: snapshots taken by the worker, plus "now". */
  app.get(
    '/equity',
    { schema: { tags: ['portfolio'], security: [{ bearer: [] }], querystring: q } },
    async (req) => {
      const acct = await resolveAccount(pool, req.user!.id, req.query.competitionId);
      const r = await pool.query(
        `SELECT extract(epoch FROM ts)::bigint AS time, equity_paise AS equity FROM equity_snapshots
       WHERE account_id = $1 AND ts > now() - interval '30 days' ORDER BY ts`,
        [acct],
      );
      const now = await portfolioOf(pool, acct);
      return [...r.rows, { time: Math.floor(Date.now() / 1000), equity: now.equity }];
    },
  );
};
