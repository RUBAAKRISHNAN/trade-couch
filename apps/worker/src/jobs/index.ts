import { Queue, Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { config, type Pool } from '@tradecore/shared/node';
import { runCoach } from '@tradecore/api';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null };

type Handler = (pool: Pool, log: Logger) => Promise<unknown>;

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
