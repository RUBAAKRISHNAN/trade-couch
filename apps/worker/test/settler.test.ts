import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import pino from 'pino';
import { streams } from '@tradecore/shared';
import { config, type Pool } from '@tradecore/shared/node';
import { Settler } from '../src/settler';

// Real Redis (Memurai locally, a service container in CI). No events are published, so Postgres is never touched.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const symbol = `LEASE-TEST-${Date.now().toString(36)}`;
const keyPrefix = 'tc:test:lease:';
const leaseKey = `${keyPrefix}${symbol}`;
const log = pino({ level: 'silent' });
const opts = { leaseMs: 300, retryMs: 50, keyPrefix };

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

afterAll(async () => {
  await redis.del(leaseKey, streams.events(symbol));
  redis.disconnect();
});

describe('settler lease', () => {
  it('a settler that loses its lease goes back to standby and a settler takes over — never two at once', async () => {
    const mk = () =>
      new Settler(symbol, redis, new Redis(config.redisUrl), undefined as unknown as Pool, log, opts);
    const a = mk();
    const b = mk();
    const states: string[] = [];
    const sample = setInterval(() => states.push(`${a.state}/${b.state}`), 10);

    void a.run();
    await until(() => a.state === 'active');
    void b.run();
    await new Promise((r) => setTimeout(r, 400));
    expect(b.state).toBe('standby'); // only one owner

    // simulate losing the lease (e.g. a renewal that came too late): someone else now holds the key briefly
    await redis.set(leaseKey, 'intruder', 'PX', 400);
    await until(() => a.state === 'standby');
    // once the intruder's lease expires, one of them takes over again
    await until(() => a.state === 'active' || b.state === 'active', 3000);

    clearInterval(sample);
    expect(states).not.toContain('active/active');

    a.stop();
    b.stop();
    await until(() => a.state === 'stopped' && b.state === 'stopped', 4000);
  });
});
