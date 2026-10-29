import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { amendOrderSchema, placeOrderSchema } from '@tradecore/shared';
import { requireAuth } from '../app';
import { resolveAccount, userAccountIds } from '../lib/accounts';
import { getInstrumentRow } from '../trading/instruments';
import { placeOrder, requestAmend, requestCancel, type OrderRow } from '../trading/orders';

const ordersLimit = { rateLimit: { max: 30, timeWindow: '10 seconds' } };

export function orderView(o: OrderRow & { qty_scale?: number }, qtyScale = o.qty_scale ?? 1) {
  return {
    id: o.id,
    accountId: o.account_id,
    symbol: o.symbol,
    clientOrderId: o.client_order_id,
    side: o.side,
    type: o.type,
    tif: o.tif,
    qty: o.qty_units,
    filled: o.filled_units,
    price: o.price_paise,
    stopPrice: o.stop_price_paise,
    protectPrice: o.protect_price_paise,
    // filled_notional is in paise for units; scale back up to a price per whole coin/share
    avgFillPrice: o.filled_units ? Math.round((o.filled_notional_paise * qtyScale) / o.filled_units) : null,
    filledNotional: o.filled_notional_paise,
    held: o.held_cash_paise,
    heldUnits: o.held_units,
    status: o.status,
    reason: o.reason,
    planStop: o.plan_stop_paise,
    planTarget: o.plan_target_paise,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

export const orderRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool, bus } = app.deps;
  app.addHook('preHandler', requireAuth);

  app.post(
    '/',
    { config: ordersLimit, schema: { tags: ['orders'], security: [{ bearer: [] }], body: placeOrderSchema } },
    async (req, reply) => {
      const accountId = await resolveAccount(pool, req.user!.id, req.body.competitionId);
      const o = await placeOrder(pool, bus, accountId, req.body);
      reply.status(202); // accepted for matching; the outcome arrives via websocket / GET
      return orderView(o, (await getInstrumentRow(pool, o.symbol)).qty_scale);
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['orders'],
        security: [{ bearer: [] }],
        querystring: z.object({
          status: z.enum(['open', 'all']).default('open'),
          symbol: z.string().optional(),
          competitionId: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req) => {
      const accountId = await resolveAccount(pool, req.user!.id, req.query.competitionId);
      const r = await pool.query<OrderRow>(
        `SELECT o.*, i.qty_scale FROM orders o JOIN instruments i USING (symbol) WHERE o.account_id = $1 AND ($2::text IS NULL OR o.symbol = $2)
           AND ($3 = 'all' OR o.status IN ('PENDING','OPEN','PARTIALLY_FILLED'))
         ORDER BY o.created_at DESC LIMIT $4`,
        [accountId, req.query.symbol ?? null, req.query.status, req.query.limit],
      );
      return r.rows.map((o) => orderView(o));
    },
  );

  app.delete(
    '/:id',
    {
      config: ordersLimit,
      schema: {
        tags: ['orders'],
        security: [{ bearer: [] }],
        params: z.object({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      const o = await requestCancel(pool, bus, await userAccountIds(pool, req.user!.id), req.params.id);
      reply.status(202);
      return { id: o.id, status: 'CANCEL_REQUESTED' };
    },
  );

  app.delete(
    '/',
    {
      config: ordersLimit,
      schema: {
        tags: ['orders'],
        security: [{ bearer: [] }],
        querystring: z.object({ symbol: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const ids = await userAccountIds(pool, req.user!.id);
      const open = await pool.query<{ id: number }>(
        `SELECT id FROM orders WHERE account_id = ANY($1::bigint[]) AND ($2::text IS NULL OR symbol = $2) AND status IN ('PENDING','OPEN','PARTIALLY_FILLED')`,
        [ids, req.query.symbol ?? null],
      );
      for (const o of open.rows) await requestCancel(pool, bus, ids, o.id).catch(() => {});
      reply.status(202);
      return { requested: open.rowCount };
    },
  );

  app.patch(
    '/:id',
    {
      config: ordersLimit,
      schema: {
        tags: ['orders'],
        security: [{ bearer: [] }],
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: amendOrderSchema,
      },
    },
    async (req, reply) => {
      const o = await requestAmend(
        pool,
        bus,
        await userAccountIds(pool, req.user!.id),
        req.params.id,
        req.body,
      );
      reply.status(202);
      return { id: o.id, status: 'AMEND_REQUESTED' };
    },
  );
};
