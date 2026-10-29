import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool, redis } = app.deps;
  app.get('/health', { config: { rateLimit: false }, schema: { tags: ['system'] } }, async (_req, reply) => {
    const [db, rd] = await Promise.allSettled([pool.query('SELECT 1'), redis.ping()]);
    const ok = db.status === 'fulfilled' && rd.status === 'fulfilled';
    reply.status(ok ? 200 : 503);
    return {
      ok,
      db: db.status === 'fulfilled',
      redis: rd.status === 'fulfilled',
      time: new Date().toISOString(),
    };
  });
};
