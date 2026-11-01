import { Queue, Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { config, type Pool } from '@tradecore/shared/node';
import { Redis } from 'ioredis';
import { reapLostOrders, runCoach } from '@tradecore/api';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null };

type Handler = (pool: Pool, log: Logger) => Promise<unknown>;

let redisForReaper: Redis | undefined;
const reaperRedis = () =>
  (redisForReaper ??= new Redis(config.redisUrl, { maxRetriesPerRequest: null, connectionName: 'reaper' }));

const CANDLE_TFS: [tf: string, bucket: string, lookback: string][] = [
  ['1m', '1 minute', '3 minutes'],
  ['5m', '5 minutes', '10 minutes'],
  ['1h', '1 hour', '1 hour'],
  ['1d', '1 day', '1 day'],
];

/**
 * OHLC with window functions: within each (symbol, bucket) ordered by time,
 * first_value(price) is the open and last_value(price) (over the whole frame) is the close.
 */
export async function rollUpCandles(pool: Pool) {
  let rows = 0;
  for (const [tf, bucket, lookback] of CANDLE_TFS) {
    const r = await pool.query(
      `WITH x AS (
         SELECT symbol, date_bin($2::interval, executed_at, timestamptz '2000-01-01') AS bucket, price_paise, qty_units,
                first_value(price_paise) OVER w AS o,
                last_value(price_paise) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS c
         FROM trades
         WHERE executed_at >= date_bin($2::interval, now() - $3::interval, timestamptz '2000-01-01')
         WINDOW w AS (PARTITION BY symbol, date_bin($2::interval, executed_at, timestamptz '2000-01-01') ORDER BY executed_at, id))
       INSERT INTO candles (symbol, timeframe, bucket_start, open_paise, high_paise, low_paise, close_paise, volume_units, trade_count)
       SELECT symbol, $1, bucket, min(o), max(price_paise), min(price_paise), min(c), sum(qty_units), count(*)
       FROM x GROUP BY symbol, bucket
       ON CONFLICT (symbol, timeframe, bucket_start) DO UPDATE SET
         open_paise = EXCLUDED.open_paise, high_paise = EXCLUDED.high_paise, low_paise = EXCLUDED.low_paise,
         close_paise = EXCLUDED.close_paise, volume_units = EXCLUDED.volume_units, trade_count = EXCLUDED.trade_count`,
      [tf, bucket, lookback],
    );
    rows += r.rowCount ?? 0;
  }
  return rows;
}

/**
 * Scheduled maintenance jobs. BullMQ stores schedules in Redis, so with several worker processes each
 * job still runs once per interval (and retries if a run fails).
 */
export const JOBS: Record<string, { everyMs: number; run: Handler }> = {
  // Native partitions must exist BEFORE rows arrive; keep a week ahead.
  'ensure-partitions': {
    everyMs: 60 * 60_000,
    run: async (pool) =>
      (
        await pool.query<{ a: number; b: number }>(
          `SELECT ensure_daily_partitions('trades', current_date, 8) AS a, ensure_daily_partitions('order_events', current_date, 8) AS b`,
        )
      ).rows[0],
  },
  // Leaderboards: CONCURRENTLY keeps the views readable during the refresh (needs their UNIQUE indexes).
  // Order matters: mv_leaderboard is built from mv_portfolio_summary.
  'refresh-leaderboards': {
    everyMs: 10_000,
    run: async (pool) => {
      await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_portfolio_summary');
      await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_leaderboard');
      return 'ok';
    },
  },
  // Candles: roll recent trades up into the candles table for every timeframe. Each lookback starts on a
  // bucket boundary, so the current bucket is always recomputed whole (idempotent upsert).
  'roll-up-candles': { everyMs: 30_000, run: (pool) => rollUpCandles(pool) },
  // Equity curve + drawdown: one sample per human account every 5 minutes.
  'equity-snapshots': {
    everyMs: 5 * 60_000,
    run: async (pool) =>
      (
        await pool.query(
          `INSERT INTO equity_snapshots (account_id, ts, equity_paise, cash_paise)
           SELECT account_id, date_trunc('minute', now()), equity_paise, cash_paise FROM mv_portfolio_summary
           ON CONFLICT DO NOTHING`,
        )
      ).rowCount,
  },
  // Orders lost between the database commit and the engine stream (process died in between): reject them and
  // release their holds — but only once it's provably safe (see apps/api/src/trading/reaper.ts).
  'reap-lost-orders': {
    everyMs: 30_000,
    run: async (_pool, log) => {
      const res = await reapLostOrders(_pool, reaperRedis());
      for (const r of res) if (r.reaped || r.skipped) log.warn(r, 'lost-order reaper');
      return res;
    },
  },
  // Trade Coach: turn newly settled trades into graded round trips, weekly skill scores and badges.
  coach: { everyMs: 10_000, run: (pool) => runCoach(pool) },
  // Market-maker quotes that were cancelled without ever trading carry no history worth keeping.
  'prune-bot-orders': {
    everyMs: 15 * 60_000,
    run: async (pool) =>
      (
        await pool.query(
          `DELETE FROM orders WHERE is_bot AND status IN ('CANCELLED', 'REJECTED') AND filled_units = 0
           AND updated_at < now() - interval '30 minutes'`,
        )
      ).rowCount,
  },
};

export async function startJobs(pool: Pool, log: Logger) {
  const queue = new Queue('maintenance', { connection });
  for (const [name, j] of Object.entries(JOBS)) {
    await queue.upsertJobScheduler(
      name,
      { every: j.everyMs },
      { name, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
    await queue.add(name, {}, { removeOnComplete: 100, removeOnFail: 100 }); // run once at startup
  }
  const worker = new Worker(
    'maintenance',
    async (job: Job) => {
      const j = JOBS[job.name];
      if (!j) return;
      const t = Date.now();
      const result = await j.run(pool, log);
      log.info({ job: job.name, ms: Date.now() - t, result }, 'job done');
      return result;
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) => log.error({ job: job?.name, err: err.message }, 'job failed'));
  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
