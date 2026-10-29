import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loginSchema, registerSchema } from '@tradecore/shared';
import { withTx } from '@tradecore/shared/node';
import { requireAuth } from '../app';
import { AppError } from '../errors';
import {
  ACCESS_TTL_S,
  REFRESH_COOKIE,
  REFRESH_TTL_S,
  hashPassword,
  issueRefresh,
  revokeRefresh,
  rotateRefresh,
  signAccess,
  verifyPassword,
} from '../lib/auth';
import { createAccount } from '../trading/accounts';

const authLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };
const userOut = z.object({ id: z.string(), email: z.string(), displayName: z.string(), role: z.string() });
const tokenOut = z.object({ accessToken: z.string(), expiresIn: z.number(), user: userOut });

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: REFRESH_TTL_S,
  });
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool, prisma } = app.deps;

  const respond = async (
    reply: FastifyReply,
    u: { id: string; email: string; displayName: string; role: string },
    refresh: string,
  ) => {
    setRefreshCookie(reply, refresh);
    return {
      accessToken: await signAccess({ sub: u.id, role: u.role as 'USER', name: u.displayName }),
      expiresIn: ACCESS_TTL_S,
      user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role },
    };
  };

  app.post(
    '/register',
    { config: authLimit, schema: { tags: ['auth'], body: registerSchema, response: { 201: tokenOut } } },
    async (req, reply) => {
      const { email, password, displayName } = req.body;
      const hash = await hashPassword(password);
      const user = await withTx(pool, async (c) => {
        const r = await c.query<{ id: string; email: string; display_name: string; role: string }>(
          `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
           ON CONFLICT (email) DO NOTHING RETURNING id, email, display_name, role`,
          [email, hash, displayName],
        );
        if (!r.rows[0]) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
        await createAccount(c, r.rows[0].id); // ₹1,00,000 virtual cash
        return r.rows[0];
      });
      const rt = await issueRefresh(pool, user.id);
      reply.status(201);
      return respond(
        reply,
        { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
        rt.token,
      );
    },
  );

  app.post(
    '/login',
    { config: authLimit, schema: { tags: ['auth'], body: loginSchema, response: { 200: tokenOut } } },
    async (req, reply) => {
      const u = await prisma.user.findUnique({ where: { email: req.body.email } });
      // same error and similar timing whether the email exists or not (no user enumeration)
      const ok = await verifyPassword(
        req.body.password,
        u?.passwordHash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva',
      );
      if (!u || !ok || u.role === 'BOT')
        throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong email or password');
      const rt = await issueRefresh(pool, u.id);
      return respond(reply, u, rt.token);
    },
  );

  app.post(
    '/refresh',
    { config: authLimit, schema: { tags: ['auth'], response: { 200: tokenOut } } },
    async (req, reply) => {
      const token = req.cookies[REFRESH_COOKIE];
      if (!token) throw new AppError(401, 'UNAUTHORIZED', 'No refresh token');
      try {
        const { userId, token: next } = await rotateRefresh(pool, token);
        const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        return respond(reply, u, next);
      } catch (e) {
        reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
        throw e;
      }
    },
  );

  app.post('/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) await revokeRefresh(pool, token);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  app.get(
    '/me',
    { preHandler: requireAuth, schema: { tags: ['auth'], security: [{ bearer: [] }] } },
    async (req) => {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
      const accounts = (
        await pool.query(
          `SELECT a.id, a.competition_id, c.name AS competition_name, a.starting_cash_paise
         FROM accounts a LEFT JOIN competitions c ON c.id = a.competition_id WHERE a.user_id = $1 ORDER BY a.id`,
          [u.id],
        )
      ).rows;
      return { user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role }, accounts };
    },
  );
};
