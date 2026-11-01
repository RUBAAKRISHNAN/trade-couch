import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { config } from '@tradecore/shared/node';
import { AppError } from './errors';
import { verifyAccess } from './lib/auth';
import type { AppDeps } from './lib/context';
import { authRoutes } from './routes/auth';
import { marketRoutes } from './routes/market';
import { orderRoutes } from './routes/orders';
import { portfolioRoutes } from './routes/portfolio';
import { healthRoutes } from './routes/health';
import { coachRoutes } from './routes/coach';

export async function buildApp(deps: AppDeps, opts: { logger?: boolean | object; rateLimit?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID(),
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();
  app.decorate('deps', deps);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // optional auth on every request (added BEFORE the rate limiter so limits can be per user);
  // `requireAuth` enforces it per route
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      const c = await verifyAccess(h.slice(7)).catch(() => undefined);
      if (c) req.user = { id: c.sub, role: c.role, name: c.name };
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false }); // JSON API; Swagger UI needs inline scripts
  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(cookie);
  if (opts.rateLimit !== false)
    await app.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: '1 minute',
      redis: deps.redis,
      nameSpace: 'tc:rl:',
      keyGenerator: (req) => req.user?.id ?? req.ip,
    });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'TradeCore API',
        version: '0.1.0',
        description:
          'Virtual-money trading simulator. Prices in paise, quantities in instrument units. Not investment advice.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // central error handler: AppError → its status; validation → 400; everything else → 500 (logged)
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply
        .status(err.status)
        .send({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
    if (hasZodFastifySchemaValidationErrors(err))
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'Invalid request',
          details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
        requestId: req.id,
      });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429)
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' },
        requestId: req.id,
      });
    if (status && status < 500)
      return reply
        .status(status)
        .send({ error: { code: 'BAD_REQUEST', message: (err as Error).message }, requestId: req.id });
    req.log.error({ err }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'Something went wrong' }, requestId: req.id });
  });

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(marketRoutes, { prefix: '/api' });
  await app.register(orderRoutes, { prefix: '/api/orders' });
  await app.register(portfolioRoutes, { prefix: '/api/portfolio' });
  await app.register(coachRoutes, { prefix: '/api/coach' });
  return app;
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Please log in');
}
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Please log in');
  if (req.user.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Admins only');
}

export type App = Awaited<ReturnType<typeof buildApp>>;
