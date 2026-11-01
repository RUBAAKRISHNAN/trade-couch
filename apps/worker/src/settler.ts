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
 * even a duplicate delivery after a crash or a lease hand-over is harmless.
 *
 * Losing the lease (a renewal failed or another process took over) sends the settler back to STANDBY:
 * it stops consuming and keeps trying to re-acquire, so some settler always ends up active. Only stop()
 * (process shutdown) ends it for good.
 */
export class Settler {
  private shuttingDown = false;
  private leaseLost = false;
  private leaseTimer: NodeJS.Timeout | undefined;
  private readonly owner = `settler-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  state: 'standby' | 'active' | 'stopped' = 'standby';
  settled = 0;
  lastSettledAt = 0;

  constructor(
    private symbol: string,
    private redis: Redis,
    private reader: Redis,
    private pool: Pool,
    private log: Logger,
    private opts: { leaseMs?: number; retryMs?: number; keyPrefix?: string } = {},
  ) {}

  private get leaseMs() {
    return this.opts.leaseMs ?? LEASE_MS;
  }

  private leaseKey() {
    return `${this.opts.keyPrefix ?? 'tc:lease:settler:'}${this.symbol}`;
  }

  private async acquire(): Promise<boolean> {
    return (await this.redis.set(this.leaseKey(), this.owner, 'PX', this.leaseMs, 'NX')) === 'OK';
  }

  private async renew(): Promise<boolean> {
    // renew only if we still own it (atomic compare-and-extend)
    const r = await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`,
      1,
      this.leaseKey(),
      this.owner,
      this.leaseMs,
    );
    return r === 1;
  }

  async run() {
    while (!this.shuttingDown) {
      // standby: wait for the lease
      this.state = 'standby';
      while (!this.shuttingDown && !(await this.acquire().catch(() => false)))
        await new Promise((r) => setTimeout(r, this.opts.retryMs ?? 2000));
      if (this.shuttingDown) break;

      this.leaseLost = false;
      this.state = 'active';
      this.leaseTimer = setInterval(() => {
        // a Redis error counts as lost too: we can no longer prove we hold the lease
        void this.renew()
          .catch(() => false)
          .then((ok) => {
            if (ok || this.leaseLost || this.shuttingDown) return;
            this.leaseLost = true;
            this.state = 'standby';
            this.log.warn({ symbol: this.symbol }, 'lost settler lease, returning to standby');
          });
      }, this.leaseMs / 3);
      try {
        await this.consume();
      } catch (e) {
        this.log.error({ err: e, symbol: this.symbol }, 'settler loop crashed; returning to standby');
      } finally {
        clearInterval(this.leaseTimer);
      }
    }
    this.state = 'stopped';
  }

  private async consume() {
    const key = streams.events(this.symbol);
    try {
      await this.redis.xgroup('CREATE', key, SETTLER_GROUP, '0', 'MKSTREAM');
    } catch (e) {
      if (!String(e).includes('BUSYGROUP')) throw e;
    }
    this.log.info({ symbol: this.symbol }, 'settler running');
    let cursor = '0'; // first re-read anything delivered but not acknowledged (e.g. by a previous owner)
    while (!this.shuttingDown && !this.leaseLost) {
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
      // the lease may have been lost while we were blocked reading: leave these entries pending (unacked) so the
      // new owner re-reads them. Even if two settlers overlapped, engine_offsets (locked FOR UPDATE) keeps it exactly-once.
      if (this.leaseLost || this.shuttingDown) break;
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
    this.shuttingDown = true;
    clearInterval(this.leaseTimer);
    void this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      this.leaseKey(),
      this.owner,
    );
  }
}
