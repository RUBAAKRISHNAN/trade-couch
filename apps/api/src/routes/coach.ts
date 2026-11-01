import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../app';
import { resolveAccount } from '../lib/accounts';
import { AppError } from '../errors';
import { buildChatRequest, buildTraderContext, COACH_SYSTEM_PROMPT, GeminiError } from '../coach/chat';

const q = z.object({ competitionId: z.coerce.number().int().positive().optional() });

export const coachRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool, chat } = app.deps;
  app.addHook('preHandler', requireAuth);

  app.get('/chat/status', { schema: { tags: ['coach'], security: [{ bearer: [] }] } }, async () => ({
    enabled: !!chat,
    model: chat?.name ?? null,
  }));

  /**
   * AI coach chat, streamed as Server-Sent Events: `data: {"text": "..."}` chunks, then `data: {"done": true}`,
   * or `data: {"error": "..."}`. The client sends the conversation so far (the server stores nothing).
   */
  app.post(
    '/chat',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['coach'],
        security: [{ bearer: [] }],
        body: z.object({
          competitionId: z.number().int().positive().optional(),
          messages: z
            .array(z.object({ role: z.enum(['user', 'model']), text: z.string().trim().min(1).max(2000) }))
            .min(1)
            .max(20)
            .refine((m) => m.at(-1)?.role === 'user', 'the last message must be from the user'),
        }),
      },
    },
    async (req, reply) => {
      if (!chat)
        throw new AppError(
          503,
          'AI_DISABLED',
          'The AI coach is not set up: add GEMINI_API_KEY to .env and restart',
        );
      const acct = await resolveAccount(pool, req.user!.id, req.body.competitionId);
      const context = await buildTraderContext(pool, acct);

      const abort = new AbortController();
      req.raw.on('close', () => abort.abort());
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-request-id': req.id,
      });
      const send = (o: object) => reply.raw.write(`data: ${JSON.stringify(o)}\n\n`);
      try {
        for await (const text of chat.stream(
          COACH_SYSTEM_PROMPT,
          buildChatRequest(context, req.body.messages),
          abort.signal,
        ))
          send({ text });
        send({ done: true });
      } catch (e) {
        if (!abort.signal.aborted) {
          req.log.warn({ err: e instanceof GeminiError ? e.message : String(e) }, 'coach chat failed');
          send({
            error:
              e instanceof GeminiError && (e.status === 401 || e.status === 403 || e.status === 400)
                ? 'The AI service rejected the request — check GEMINI_API_KEY and GEMINI_MODEL in .env.'
                : e instanceof GeminiError && e.status === 429
                  ? 'The AI service is busy or your free quota is used up. Try again in a minute.'
                  : 'The AI coach could not answer right now. Please try again.',
          });
        }
      } finally {
        reply.raw.end();
      }
    },
  );

  /** Skill Score (this week + history), grade mix, habit counts, badges. */
  app.get(
    '/summary',
    { schema: { tags: ['coach'], security: [{ bearer: [] }], querystring: q } },
    async (req) => {
      const acct = await resolveAccount(pool, req.user!.id, req.query.competitionId);
      const [weeks, totals, flags, badges, open] = await Promise.all([
        pool.query(
          `SELECT week_start, skill_score, trades, win_rate::float AS win_rate, avg_win_paise, avg_loss_paise,
                  max_drawdown_paise, habits, goal, ai_summary
           FROM weekly_skill WHERE account_id = $1 ORDER BY week_start DESC LIMIT 12`,
          [acct],
        ),
        pool.query(
          `SELECT count(*)::int AS trips, round(avg(c.score))::int AS avg_score,
                  count(*) FILTER (WHERE r.pnl_paise > 0)::int AS wins,
                  COALESCE(sum(r.pnl_paise), 0)::bigint AS pnl
           FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id
           WHERE r.account_id = $1`,
          [acct],
        ),
        pool.query(
          `SELECT f AS flag, count(*)::int AS n FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id,
                  unnest(c.flags) f
           WHERE r.account_id = $1 AND r.closed_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`,
          [acct],
        ),
        pool.query(
          `SELECT b.code, b.name, b.description, b.icon, ub.awarded_at
           FROM badges b LEFT JOIN user_badges ub ON ub.badge_code = b.code AND ub.user_id = $1 ORDER BY b.code`,
          [req.user!.id],
        ),
        pool.query(
          `SELECT symbol, qty_units AS qty, opened_at FROM coach_positions WHERE account_id = $1 ORDER BY opened_at`,
          [acct],
        ),
      ]);
      const gradeMix = (
        await pool.query<{ grade: string; n: number }>(
          `SELECT c.grade, count(*)::int AS n FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id
           WHERE r.account_id = $1 GROUP BY 1`,
          [acct],
        )
      ).rows;
      const t = totals.rows[0];
      return {
        accountId: acct,
        current: weeks.rows[0] ?? null,
        weeks: weeks.rows.reverse(),
        totals: {
          trips: t?.trips ?? 0,
          avgScore: t?.avg_score ?? null,
          wins: t?.wins ?? 0,
          pnl: Number(t?.pnl ?? 0),
          grades: Object.fromEntries(gradeMix.map((g) => [g.grade, g.n])),
        },
        flags: flags.rows,
        badges: badges.rows.map((b) => ({ ...b, earned: !!b.awarded_at })),
        openPositions: open.rows,
      };
    },
  );

  /** Graded round trips, newest first (keyset pagination on closed_at, id). */
  app.get(
    '/trips',
    {
      schema: {
        tags: ['coach'],
        security: [{ bearer: [] }],
        querystring: q.extend({
          limit: z.coerce.number().int().min(1).max(100).default(30),
          before: z.coerce.number().int().positive().optional(),
        }),
      },
    },
    async (req) => {
      const acct = await resolveAccount(pool, req.user!.id, req.query.competitionId);
      const r = await pool.query(
        `SELECT r.id, r.symbol, i.name, i.qty_scale, r.qty_units AS qty, r.entry_avg_paise AS entry_price,
                r.exit_avg_paise AS exit_price, r.pnl_paise AS pnl, r.equity_at_open_paise AS equity_at_open,
                r.opened_at, r.closed_at, r.plan_stop_paise AS plan_stop, r.plan_target_paise AS plan_target,
                r.had_stop_order, r.source, c.grade, c.score, c.flags, c.tip, c.details
         FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id JOIN instruments i ON i.symbol = r.symbol
         WHERE r.account_id = $1 AND ($2::bigint IS NULL OR r.id < $2)
         ORDER BY r.closed_at DESC, r.id DESC LIMIT $3`,
        [acct, req.query.before ?? null, req.query.limit],
      );
      return r.rows;
    },
  );
};
