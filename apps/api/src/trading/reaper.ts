import type { Redis } from 'ioredis';
import { ENGINE_GROUP, LOST_ORDER_AFTER_MS, streams } from '@tradecore/shared';
import type { Pool } from '@tradecore/shared/node';
import { failPendingOrder } from './orders';

/**
 * LOST-ORDER REAPER — the fix for the "dual write" gap in order placement.
 *
 * Placing an order is two writes: the order row + hold commit in Postgres, THEN the command is added to the
 * engine's Redis stream. If the process dies between the two, the order stays PENDING forever with its cash or
 * coins reserved. The reaper finds such orders and rejects them (reason NOT_DELIVERED), releasing the hold.
 *
 * Rejecting an order the engine might still match would be a serious bug (it would fill with no hold behind it),
 * so a symbol is only reaped when ALL of these hold:
 *   1. the order is older than LOST_ORDER_AFTER_MS and has no engine events at all;
 *   2. the engine has consumed every command in the stream: its consumer group has nothing pending and lag 0;
 *   3. a fresh engine heartbeat (taken after step 2) shows a seq that settlement has already reached.
 * Then, if the command had ever been added to the stream, the engine has processed it and settlement has written
 * its events — so "no events" proves it was never sent. One race remains: a stalled API process that adds the
 * command AFTER the reaper ran. The engine rejects any NEW order older than NEW_ORDER_TTL_MS (half the reaper's
 * wait) as STALE, so even that command can never be matched.
 */

export interface ReapResult {
  symbol: string;
  candidates: number;
  reaped: number;
  /** why the symbol was skipped (nothing was changed), if it was */
  skipped?: 'engine-behind' | 'no-heartbeat' | 'settlement-behind';
}

interface Opts {
  /** stream key for a symbol's commands (tests use their own keys) */
  commandStream?: (symbol: string) => string;
  /** Redis hash holding the engine heartbeat per symbol */
  heartbeatKey?: string;
  /** how long to wait for a heartbeat newer than the stream check */
  heartbeatWaitMs?: number;
  /** how long to wait for settlement to reach the heartbeat's seq */
  settleWaitMs?: number;
  olderThanMs?: number;
}

/** XINFO GROUPS returns flat [k, v, k, v…] arrays; turn each group into an object. */
function parseGroups(raw: unknown): Record<string, unknown>[] {
  return (raw as unknown[][]).map((g) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < g.length; i += 2) o[String(g[i])] = g[i + 1];
    return o;
  });
}

async function engineCaughtUp(redis: Redis, key: string): Promise<boolean> {
  const groups = parseGroups(await redis.xinfo('GROUPS', key).catch(() => []));
  const g = groups.find((x) => x.name === ENGINE_GROUP);
  // lag is null when Redis can't tell; treat "unknown" as "not safe"
  return !!g && Number(g.pending) === 0 && g.lag !== null && g.lag !== undefined && Number(g.lag) === 0;
}

export async function reapLostOrders(pool: Pool, redis: Redis, opts: Opts = {}): Promise<ReapResult[]> {
  const olderThan = opts.olderThanMs ?? LOST_ORDER_AFTER_MS;
  const candidates = (
    await pool.query<{ symbol: string; ids: number[] }>(
      `SELECT o.symbol, array_agg(o.id ORDER BY o.id) AS ids
       FROM orders o
       WHERE o.status = 'PENDING' AND o.created_at < now() - make_interval(secs => $1::float8 / 1000)
         AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id)
       GROUP BY o.symbol`,
      [olderThan],
    )
  ).rows;

  const out: ReapResult[] = [];
  for (const { symbol, ids } of candidates) {
    const res: ReapResult = { symbol, candidates: ids.length, reaped: 0 };
    out.push(res);

    const checkedAt = Date.now();
    if (!(await engineCaughtUp(redis, (opts.commandStream ?? streams.commands)(symbol)))) {
      res.skipped = 'engine-behind';
      continue;
    }
    // wait for a heartbeat taken AFTER the stream check (the engine writes one every second)
    let hb: { seq: number; at: number } | null = null;
    const deadline = Date.now() + (opts.heartbeatWaitMs ?? 3000);
    while (Date.now() < deadline) {
      const raw = await redis.hget(opts.heartbeatKey ?? 'tc:health:engine', symbol);
      const h = raw ? (JSON.parse(raw) as { seq: number; at: number }) : null;
      if (h && h.at > checkedAt) {
        hb = h;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!hb) {
      res.skipped = 'no-heartbeat';
      continue;
    }
    // settlement normally trails the engine by milliseconds; on a busy symbol give it a moment to reach hb.seq
    let settled: number | undefined;
    const settleDeadline = Date.now() + (opts.settleWaitMs ?? 2000);
    do {
      settled = (
        await pool.query<{ last_seq: number }>('SELECT last_seq FROM engine_offsets WHERE symbol = $1', [
          symbol,
        ])
      ).rows[0]?.last_seq;
      if (settled !== undefined && settled >= hb.seq) break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < settleDeadline);
    if (settled === undefined || settled < hb.seq) {
      res.skipped = 'settlement-behind';
      continue;
    }

    for (const id of ids) if (await failPendingOrder(pool, id, 'NOT_DELIVERED')) res.reaped++;
  }
  return out;
}
