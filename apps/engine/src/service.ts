import { Redis } from 'ioredis';
import pino from 'pino';
import { ENGINE_GROUP, channels, streams, type EngineCommand, type EngineEvent } from '@tradecore/shared';
import type { Pool } from '@tradecore/shared/node';
import { OrderBook, type BookConfig } from './book/order-book';

export const log = pino({ name: 'engine', level: process.env.LOG_LEVEL ?? 'info' });

const EVENT_STREAM_MAXLEN = 200_000;
const SNAPSHOT_INTERVAL_MS = 100; // ≤ 10 book updates/sec per symbol
const BATCH = 500;

/**
 * Runs ONE symbol's order book. Everything that touches the book goes through `serial`, a promise
 * chain, so commands are processed strictly one at a time in arrival order: single-threaded per symbol.
 */
export class SymbolRunner {
  book: OrderBook;
  private serial: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private lastSnapshotAt = 0;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private consumer: string;
  processed = 0;
  lastCommandLagMs = 0;

  constructor(
    readonly cfg: BookConfig,
    private redis: Redis,
    private reader: Redis,
    private pool: Pool,
  ) {
    this.book = new OrderBook(cfg);
    // stable name: after a crash the new process re-reads commands the old one received but never acknowledged
    this.consumer = `engine-${process.env.ENGINE_ID ?? '1'}`;
  }

  /** Crash recovery: replay the settled log from Postgres, then any newer events still in the Redis stream. */
  async recover(): Promise<void> {
    const r = await this.pool.query<{ payload: EngineEvent }>(
      'SELECT payload FROM order_events WHERE symbol = $1 ORDER BY seq',
      [this.cfg.symbol],
    );
    const fromDb = r.rows.length;
    for (const row of r.rows) this.book.apply(row.payload);
    const pending = await this.redis.xrange(streams.events(this.cfg.symbol), '-', '+');
    let fromStream = 0;
    for (const [, fields] of pending) {
      const e = JSON.parse(fields[1]!) as EngineEvent;
      if (e.seq > this.book.seq) {
        this.book.apply(e);
        fromStream++;
      }
    }
    log.info(
      { symbol: this.cfg.symbol, seq: this.book.seq, fromDb, fromStream, resting: this.book.restingCount },
      'order book rebuilt from event log',
    );
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn);
    this.serial = next.catch((e) => log.error({ err: e, symbol: this.cfg.symbol }, 'engine task failed'));
    return next;
  }

  /** Apply commands and durably publish their events before acknowledging the commands. */
  private async handle(cmds: EngineCommand[], ackIds: string[]): Promise<void> {
    const evs: EngineEvent[] = [];
    for (const c of cmds) {
      evs.push(...this.book.process(c));
      this.processed++;
      if (c.kind !== 'MARK') this.lastCommandLagMs = Date.now() - c.ts;
    }
    const p = this.redis.pipeline();
    for (const e of evs)
      p.xadd(
        streams.events(this.cfg.symbol),
        'MAXLEN',
        '~',
        EVENT_STREAM_MAXLEN,
        '*',
        'e',
        JSON.stringify(e),
      );
    if (ackIds.length) p.xack(streams.commands(this.cfg.symbol), ENGINE_GROUP, ...ackIds);
    await p.exec();
    if (evs.length) this.scheduleSnapshot();
  }

  /** Reference price from the market-data feed: moves price bands and can trigger stops. */
  mark(price: number) {
    return this.enqueue(() => this.handle([{ kind: 'MARK', price, ts: Date.now() }], []));
  }

  private scheduleSnapshot() {
    if (this.snapshotTimer) return;
    const wait = Math.max(0, SNAPSHOT_INTERVAL_MS - (Date.now() - this.lastSnapshotAt));
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.lastSnapshotAt = Date.now();
      const snap = JSON.stringify(this.book.snapshot(50, Date.now()));
      void this.redis
        .pipeline()
        .set(`tc:snap:${this.cfg.symbol}`, snap)
        .publish(channels.book(this.cfg.symbol), snap)
        .exec();
    }, wait);
  }

  async run(): Promise<void> {
    const key = streams.commands(this.cfg.symbol);
    try {
      await this.redis.xgroup('CREATE', key, ENGINE_GROUP, '0', 'MKSTREAM');
    } catch (e) {
      if (!String(e).includes('BUSYGROUP')) throw e;
    }
    this.scheduleSnapshot();
    // first drain anything delivered to us before a crash but never acknowledged ('0'), then new commands ('>')
    let cursor = '0';
    while (!this.stopped) {
      const res = (await this.reader.xreadgroup(
        'GROUP',
        ENGINE_GROUP,
        this.consumer,
        'COUNT',
        BATCH,
        'BLOCK',
        1000,
        'STREAMS',
        key,
        cursor,
      )) as [string, [string, string[]][]][] | null;
      const entries = res?.[0]?.[1] ?? [];
      if (cursor === '0' && entries.length === 0) {
        cursor = '>';
        continue;
      }
      if (entries.length === 0) continue;
      const cmds: EngineCommand[] = [];
      const ids: string[] = [];
      for (const [id, fields] of entries) {
        ids.push(id);
        try {
          cmds.push(JSON.parse(fields[1]!) as EngineCommand);
        } catch {
          log.warn({ id }, 'dropping malformed command');
        }
      }
      await this.enqueue(() => this.handle(cmds, ids));
    }
  }

  stop() {
    this.stopped = true;
  }
}

export function makeRedis(url: string, name: string) {
  return new Redis(url, { connectionName: name, maxRetriesPerRequest: null, lazyConnect: false });
}
