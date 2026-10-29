import type { Redis } from 'ioredis';
import { streams, type EngineCommand } from '@tradecore/shared';
import type { CommandBus } from './orders';

/** Sends engine commands through the per-symbol Redis stream (durable, ordered, consumer-group based). */
export class RedisCommandBus implements CommandBus {
  constructor(private redis: Redis) {}
  async send(symbol: string, cmd: EngineCommand): Promise<void> {
    await this.redis.xadd(streams.commands(symbol), 'MAXLEN', '~', 100_000, '*', 'c', JSON.stringify(cmd));
  }
}
