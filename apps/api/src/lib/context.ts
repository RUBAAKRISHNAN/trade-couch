import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Pool } from '@tradecore/shared/node';
import type { CommandBus } from '../trading/orders';

/** Everything route handlers need. Built once in main.ts (or by tests with fakes). */
export interface AppDeps {
  pool: Pool;
  prisma: PrismaClient;
  redis: Redis;
  bus: CommandBus;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    user?: { id: string; role: 'USER' | 'ADMIN' | 'BOT'; name: string };
  }
}
