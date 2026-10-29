import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { SETTLER_GROUP, channels, streams, type EngineEvent } from '@tradecore/shared';
import type { Pool } from '@tradecore/shared/node';
import { settleBatch } from '@tradecore/api';

const LEASE_MS = 10_000;

/**
 * Consumes one symbol's engine event stream and settles it in Postgres.
 * Exactly ONE settler may run per symbol (events must be applied in order), enforced with a Redis
 * lease (SET NX PX, renewed while alive). Exactly-once is enforced in Postgres by engine_offsets, so
 * even a duplicate delivery after a crash is harmless.
 */
export class Settler {
  private stopped = false;
  private leaseTimer: NodeJS.Timeout | undefined;
  private readonly owner = `settler-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  settled = 0;
  lastSettledAt = 0;

  constructor(
    private symbol: string,
    private redis: Redis,
    private reader: Redis,
    private pool: Pool,
    private log: Logger,
  ) {}

  private leaseKey() {
    return `tc:lease:settler:${this.symbol}`;
  }

  private async acquire(): Promise<boolean> {
    return (await this.redis.set(this.leaseKey(), this.owner, 'PX', LEASE_MS, 'NX')) === 'OK';
  }

  private async renew(): Promise<boolean> {
    // renew only if we still own it (atomic compare-and-extend)
    const r = await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`,
      1,
      this.leaseKey(),
      this.owner,
      LEASE_MS,
    );
    return r === 1;
  }

  async run() {
    while (!this.stopped && !(await this.acquire())) await new Promise((r) => setTimeout(r, 2000));
    this.leaseTimer = setInterval(async () => {
      if (!(await this.renew())) {
        this.log.error({ symbol: this.symbol }, 'lost settler lease, stopping');
        this.stop();
      }
    }, LEASE_MS / 3);

    const key = streams.events(this.symbol);
    try {
      await this.redis.xgroup('CREATE', key, SETTLER_GROUP, '0', 'MKSTREAM');
    } catch (e) {
      if (!String(e).includes('BUSYGROUP')) throw e;
    }
    this.log.info({ symbol: this.symbol }, 'settler running');
    let cursor = '0';
    while (!this.stopped) {
      const res = (await this.reader.xreadgroup(
        'GROUP',
        SETTLER_GROUP,
        'settler',
        'COUNT',
        500,
        'BLOCK',
        1000,
        'STREAMS',
        key,
        cursor,
      )) as [string, [string, string[]][]][] | null;
      const entries = res?.[0]?.[1] ?? [];
      if (entries.length === 0) {
        if (cursor === '0') cursor = '>';
        continue;
      }
      const events = entries.map(([, f]) => JSON.parse(f[1]!) as EngineEvent);
      try {
        const r = await settleBatch(this.pool, this.symbol, events);
        await this.redis.xack(key, SETTLER_GROUP, ...entries.map(([id]) => id));
        this.settled += r.applied;
        this.lastSettledAt = Date.now();
        // tell the API (→ websockets) what changed. Published only AFTER commit.
        const p = this.redis.pipeline();
        if (r.trades.length)
          p.publish(
            channels.trades(this.symbol),
            JSON.stringify(
              r.trades.map((t) => ({ seq: t.seq, price: t.price, qty: t.qty, side: t.aggressor, ts: t.ts })),
            ),
          );
        if (r.accountIds.length)
          p.publish(channels.account, JSON.stringify({ symbol: this.symbol, accountIds: r.accountIds }));
        await p.exec();
      } catch (e) {
        this.log.error({ err: e, symbol: this.symbol }, 'settlement failed; will retry');
        cursor = '0'; // re-read our pending entries
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.leaseTimer);
    void this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      this.leaseKey(),
      this.owner,
    );
  }
}
