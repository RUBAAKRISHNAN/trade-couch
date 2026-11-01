import { Redis } from 'ioredis';
import { config, createPool } from '@tradecore/shared/node';
import { buildApp } from './app';
import { createPrisma } from './lib/prisma';
import { attachRealtime } from './realtime';
import { RedisCommandBus } from './trading/bus';
import { GeminiProvider } from './coach/chat';

const pool = createPool(undefined, 20);
const redis = new Redis(config.redisUrl, { connectionName: 'api', maxRetriesPerRequest: 3 });
const prisma = createPrisma();
const app = await buildApp(
  {
    pool,
    prisma,
    redis,
    bus: new RedisCommandBus(redis),
    chat:
      config.aiProvider === 'gemini' && config.geminiApiKey
        ? new GeminiProvider(config.geminiApiKey, config.geminiModels)
        : undefined,
  },
  {
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  },
);
await app.ready();
const rt = await attachRealtime(app.server, pool, redis);
await app.listen({ port: config.apiPort, host: '0.0.0.0' });
app.log.info(`API on http://localhost:${config.apiPort}  ·  docs: http://localhost:${config.apiPort}/docs`);

const shutdown = async () => {
  await rt.close();
  await app.close();
  await prisma.$disconnect();
  await pool.end();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
