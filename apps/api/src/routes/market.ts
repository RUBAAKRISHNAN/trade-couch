import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { BookSnapshot } from '@tradecore/shared';
import { AppError } from '../errors';
import { getInstrumentRow, listInstruments } from '../trading/instruments';

export const TIMEFRAMES = { '1m': '1 minute', '5m': '5 minutes', '1h': '1 hour', '1d': '1 day' } as const;

export const marketRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool, redis } = app.deps;

  app.get('/instruments', { schema: { tags: ['market'] } }, async () => {
    const rows = await listInstruments(pool);
    const prices = await pool.query(
      'SELECT symbol, ref_price_paise, ref_source, last_price_paise, updated_at FROM market_prices',
    );
    const bySym = new Map(prices.rows.map((p) => [p.symbol, p]));
    return rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      kind: r.kind,
      status: r.status,
      tickSizePaise: r.tick_size_paise,
      lotSizeUnits: r.lot_size_units,
      qtyScale: r.qty_scale,
      priceBandBps: r.price_band_bps,
      refPrice: bySym.get(r.symbol)?.ref_price_paise ?? null,
      refSource: bySym.get(r.symbol)?.ref_source ?? null,
      lastPrice: bySym.get(r.symbol)?.last_price_paise ?? null,
    }));
  });

  /** 24h ticker per symbol: last price, change and volume, computed from the trades table. */
  app.get('/market/ticker', { schema: { tags: ['market'] } }, async () => {
    const r = await pool.query(
      `SELECT i.symbol, mp.ref_price_paise AS ref, mp.ref_source AS source, mp.last_price_paise AS last,
              t.open_24h, t.high_24h, t.low_24h, COALESCE(t.volume_24h, 0) AS volume_24h, COALESCE(t.trades_24h, 0) AS trades_24h
       FROM instruments i
       LEFT JOIN market_prices mp ON mp.symbol = i.symbol
       LEFT JOIN LATERAL (
         SELECT (array_agg(price_paise ORDER BY executed_at, id))[1] AS open_24h, max(price_paise) AS high_24h,
                min(price_paise) AS low_24h, sum(qty_units) AS volume_24h, count(*) AS trades_24h
         FROM trades WHERE symbol = i.symbol AND executed_at > now() - interval '24 hours') t ON true
       WHERE i.status <> 'DISABLED' ORDER BY i.symbol`,
    );
    return r.rows;
  });

  app.get(
    '/market/:symbol/book',
    { schema: { tags: ['market'], params: z.object({ symbol: z.string() }) } },
    async (req) => {
      await getInstrumentRow(pool, req.params.symbol);
      const raw = await redis.get(`tc:snap:${req.params.symbol}`);
      if (!raw) throw new AppError(503, 'NO_BOOK', 'Order book not available yet (is the engine running?)');
      return JSON.parse(raw) as BookSnapshot;
    },
  );

  app.get(
    '/market/:symbol/trades',
    {
      schema: {
        tags: ['market'],
        params: z.object({ symbol: z.string() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
      },
    },
    async (req) => {
      const r = await pool.query(
        `SELECT seq, price_paise AS price, qty_units AS qty, aggressor AS side, executed_at AS ts
         FROM trades WHERE symbol = $1 ORDER BY executed_at DESC, seq DESC LIMIT $2`,
        [req.params.symbol, req.query.limit],
      );
      return r.rows;
    },
  );

  /**
   * OHLC candles. Stored candles (rolled up by the worker, plus seeded history) are merged with candles
   * computed live from recent trades using window functions:
   *   first_value(price) / last_value(price) OVER (PARTITION BY bucket ORDER BY time) → open / close
   * and a 20-period moving average with AVG(close) OVER (ORDER BY bucket ROWS 19 PRECEDING).
   */
  app.get(
    '/market/:symbol/candles',
    {
      schema: {
        tags: ['market'],
        params: z.object({ symbol: z.string() }),
        querystring: z.object({
          tf: z.enum(['1m', '5m', '1h', '1d']).default('1m'),
          limit: z.coerce.number().int().min(10).max(1000).default(300),
        }),
      },
    },
    async (req) => {
      const { tf, limit } = req.query;
      const r = await pool.query(
        `WITH bounds AS (SELECT now() - ($3::int * $2::interval) AS since),
         live AS (
           SELECT bucket, min(o) AS open, max(price_paise) AS high, min(price_paise) AS low, min(c) AS close,
                  sum(qty_units) AS volume, count(*) AS trades
           FROM (
             SELECT date_bin($2::interval, executed_at, timestamptz '2000-01-01') AS bucket, price_paise, qty_units,
                    first_value(price_paise) OVER w AS o,
                    last_value(price_paise) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS c
             FROM trades, bounds
             WHERE symbol = $1 AND executed_at >= bounds.since
             WINDOW w AS (PARTITION BY date_bin($2::interval, executed_at, timestamptz '2000-01-01') ORDER BY executed_at, id)
           ) x GROUP BY bucket
         ),
         stored AS (
           SELECT bucket_start AS bucket, open_paise AS open, high_paise AS high, low_paise AS low, close_paise AS close,
                  volume_units AS volume, trade_count AS trades
           FROM candles, bounds WHERE symbol = $1 AND timeframe = $4 AND bucket_start >= bounds.since
             AND bucket_start NOT IN (SELECT bucket FROM live)
         ),
         merged AS (SELECT * FROM stored UNION ALL SELECT * FROM live)
         SELECT extract(epoch FROM bucket)::bigint AS time, open, high, low, close, volume, trades,
                round(avg(close) OVER (ORDER BY bucket ROWS BETWEEN 19 PRECEDING AND CURRENT ROW))::bigint AS ma20
         FROM merged ORDER BY bucket`,
        [req.params.symbol, TIMEFRAMES[tf], limit, tf],
      );
      return r.rows;
    },
  );
};
