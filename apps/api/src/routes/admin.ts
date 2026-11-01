import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdmin } from '../app';
import { AppError } from '../errors';
import { getInstrumentRow, invalidateInstrument } from '../trading/instruments';
import { checkInvariants } from '../trading/invariants';

const parseHash = (h: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(h).map(([k, v]) => {
      try {
        return [k, JSON.parse(v)];
      } catch {
        return [k, v];
      }
    }),
  );

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool, redis, bus } = app.deps;
  app.addHook('preHandler', requireAdmin);
  const sec = { tags: ['admin'], security: [{ bearer: [] }] };

  /**
   * System health in one call: each service writes a heartbeat into Redis every 1–2 s (engine, worker
   * feeds/settlers, API websocket counts); the database supplies pipeline lag per symbol:
   *   engine seq → settled seq (settlement lag) → coached seq (Trade Coach lag).
   */
  app.get('/overview', { schema: sec }, async () => {
    const [engine, feeds, api, lag, counts] = await Promise.all([
      redis.hgetall('tc:health:engine'),
      redis.hgetall('tc:health:feeds'),
      redis.hgetall('tc:health:api'),
      pool.query(
        `SELECT i.symbol, i.status, eo.last_seq AS settled_seq, cc.last_seq AS coached_seq,
                (SELECT max(seq) FROM trades t WHERE t.symbol = i.symbol) AS last_trade_seq
         FROM instruments i LEFT JOIN engine_offsets eo ON eo.symbol = i.symbol
         LEFT JOIN coach_cursors cc ON cc.symbol = i.symbol ORDER BY i.symbol`,
      ),
      pool.query(
        `SELECT (SELECT count(*) FROM users WHERE role = 'USER')::int AS users,
                (SELECT count(*) FROM orders WHERE status IN ('OPEN', 'PARTIALLY_FILLED') AND NOT is_bot)::int AS open_orders,
                (SELECT count(*) FROM trades WHERE executed_at > now() - interval '24 hours')::int AS trades_24h,
                (SELECT count(*) FROM round_trips WHERE closed_at > now() - interval '24 hours' AND source = 'live')::int AS trips_24h,
                (SELECT max(refreshed_at) FROM mv_portfolio_summary) AS leaderboard_refreshed_at`,
      ),
    ]);
    const now = Date.now();
    const eng = parseHash(engine) as Record<
      string,
      { seq: number; lagMs: number; halted: boolean; at: number; resting: number }
    >;
    const apiNodes = Object.values(parseHash(api)) as { connections: number; at: number }[];
    const f = parseHash(feeds);
    return {
      now,
      engine: Object.entries(eng).map(([symbol, e]) => ({ symbol, ...e, stale: now - e.at > 5000 })),
      feeds: {
        symbols: f.symbols ?? {},
        providers: f.providers ?? {},
        settlers: f.settlers ?? {},
        usdInr: f.usdInr ? Number(f.usdInr) : null,
        stale: f.at ? now - Number(f.at) > 5000 : true,
      },
      api: {
        nodes: apiNodes.filter((n) => now - n.at < 10_000).length,
        connections: apiNodes.filter((n) => now - n.at < 10_000).reduce((s, n) => s + n.connections, 0),
      },
      pipeline: lag.rows.map((r) => ({
        symbol: r.symbol,
        status: r.status,
        engineSeq: eng[r.symbol]?.seq ?? null,
        settledSeq: r.settled_seq,
        lastTradeSeq: r.last_trade_seq,
        coachedSeq: r.coached_seq ?? 0,
      })),
      counts: counts.rows[0],
    };
  });

  app.get('/instruments', { schema: sec }, async () => {
    const r = await pool.query(
      `SELECT i.symbol, i.name, i.kind, i.status, i.price_band_bps, mp.ref_price_paise AS ref_price, mp.ref_source,
              mp.updated_at AS price_updated_at,
              (SELECT count(*)::int FROM bots b WHERE b.symbol = i.symbol AND b.enabled) AS bots
       FROM instruments i LEFT JOIN market_prices mp ON mp.symbol = i.symbol ORDER BY i.symbol`,
    );
    return r.rows;
  });

  /**
   * Halt / resume goes THROUGH the engine (a command in the symbol's stream), so it is ordered with every
   * other command: orders already queued before the halt are processed first, everything after is rejected.
   * Settlement then records the new status from the engine's HALTED / RESUMED event.
   */
  app.post(
    '/instruments/:symbol/:action',
    { schema: { ...sec, params: z.object({ symbol: z.string(), action: z.enum(['halt', 'resume']) }) } },
    async (req, reply) => {
      const inst = await getInstrumentRow(pool, req.params.symbol);
      if (inst.status === 'DISABLED') throw new AppError(409, 'DISABLED', 'Instrument is disabled');
      await bus.send(inst.symbol, { kind: req.params.action === 'halt' ? 'HALT' : 'RESUME', ts: Date.now() });
      // this node's 1 s instrument cache would otherwise still say ACTIVE; other API nodes catch up within
      // a second, and the engine rejects orders while halted regardless
      invalidateInstrument(inst.symbol);
      reply.status(202);
      return { symbol: inst.symbol, requested: req.params.action };
    },
  );

  app.get('/bots', { schema: sec }, async () => {
    const r = await pool.query(
      `SELECT b.id, b.symbol, b.kind, b.enabled, b.spread_bps, b.levels, b.level_step_bps, b.size_units,
              b.max_inventory_units, i.qty_scale, COALESCE(h.qty_units, 0) AS inventory_units, a.cash_paise
       FROM bots b JOIN instruments i ON i.symbol = b.symbol JOIN accounts a ON a.id = b.account_id
       LEFT JOIN holdings h ON h.account_id = b.account_id AND h.symbol = b.symbol
       ORDER BY b.symbol, b.kind`,
    );
    return r.rows;
  });

  /** Bot settings are read by the worker at start-up; changes apply after the worker restarts. */
  app.patch(
    '/bots/:id',
    {
      schema: {
        ...sec,
        params: z.object({ id: z.coerce.number().int() }),
        body: z
          .object({
            enabled: z.boolean().optional(),
            spreadBps: z.number().int().min(1).max(1000).optional(),
            sizeUnits: z.number().int().positive().optional(),
          })
          .refine((b) => Object.keys(b).length > 0, 'nothing to change'),
      },
    },
    async (req) => {
      const b = req.body;
      const r = await pool.query(
        `UPDATE bots SET enabled = COALESCE($2, enabled), spread_bps = COALESCE($3, spread_bps),
                         size_units = COALESCE($4, size_units), updated_at = now()
         WHERE id = $1 RETURNING id, enabled, spread_bps, size_units`,
        [req.params.id, b.enabled ?? null, b.spreadBps ?? null, b.sizeUnits ?? null],
      );
      if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Bot not found');
      return { ...r.rows[0], appliesAfter: 'worker restart' };
    },
  );

  /** Runs the ledger invariant checks on demand (same checks as `npm run check:invariants`). */
  app.post(
    '/invariants',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } }, schema: sec },
    async () => checkInvariants(pool),
  );
};
