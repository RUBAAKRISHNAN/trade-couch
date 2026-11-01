import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTx, type Pool } from '@tradecore/shared/node';
import { requireAdmin, requireAuth } from '../app';
import { AppError } from '../errors';
import { createAccount } from '../trading/accounts';

export type CompetitionStatus = 'UPCOMING' | 'LIVE' | 'ENDED';

export function competitionStatus(startsAt: Date, endsAt: Date, now = new Date()): CompetitionStatus {
  return now < startsAt ? 'UPCOMING' : now >= endsAt ? 'ENDED' : 'LIVE';
}

/** Orders in a competition wallet are only accepted while the competition is live. */
export async function assertCompetitionLive(pool: Pool, competitionId: number) {
  const c = (
    await pool.query<{ starts_at: Date; ends_at: Date }>(
      'SELECT starts_at, ends_at FROM competitions WHERE id = $1',
      [competitionId],
    )
  ).rows[0];
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Competition not found');
  const s = competitionStatus(c.starts_at, c.ends_at);
  if (s !== 'LIVE')
    throw new AppError(
      409,
      'COMPETITION_CLOSED',
      s === 'UPCOMING' ? 'This competition has not started yet' : 'This competition has ended',
    );
}

const createSchema = z
  .object({
    name: z.string().min(3).max(80),
    slug: z
      .string()
      .regex(/^[a-z0-9-]{3,60}$/, 'lowercase letters, digits and dashes')
      .optional(),
    description: z.string().max(500).default(''),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    /** rupees, for convenience; stored as paise */
    startingCashRupees: z.number().int().min(1_000).max(1_00_00_000).default(1_00_000),
  })
  .refine((c) => c.endsAt > c.startsAt, { path: ['endsAt'], message: 'must be after the start' });

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'competition';

const leaderboardRow = (r: Record<string, unknown>) => ({
  rank: Number(r.rank),
  accountId: r.account_id,
  userId: r.user_id,
  name: r.display_name,
  equity: r.equity_paise,
  pnl: r.pnl_paise,
  returnPct: Number(r.return_pct),
  roundTrips: r.round_trips,
  avgProcessScore: r.avg_process_score,
});

export const competitionRoutes: FastifyPluginAsyncZod = async (app) => {
  const { pool } = app.deps;

  /** All competitions, newest first, with live status, participants and (when logged in) whether you joined. */
  app.get('/competitions', { schema: { tags: ['competitions'] } }, async (req) => {
    const r = await pool.query(
      `SELECT c.id, c.name, c.slug, c.description, c.starts_at, c.ends_at, c.starting_cash_paise,
              (SELECT count(*)::int FROM accounts a WHERE a.competition_id = c.id) AS participants,
              me.id AS my_account_id, lb.rank AS my_rank
       FROM competitions c
       LEFT JOIN accounts me ON me.competition_id = c.id AND me.user_id = $1
       LEFT JOIN mv_leaderboard lb ON lb.account_id = me.id
       ORDER BY c.ends_at < now(), c.starts_at DESC`,
      [req.user?.id ?? null],
    );
    return r.rows.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      startsAt: c.starts_at,
      endsAt: c.ends_at,
      startingCash: c.starting_cash_paise,
      status: competitionStatus(c.starts_at, c.ends_at),
      participants: c.participants,
      joined: !!c.my_account_id,
      myRank: c.my_rank === null ? null : Number(c.my_rank),
    }));
  });

  app.post(
    '/competitions',
    {
      preHandler: requireAdmin,
      schema: { tags: ['competitions'], security: [{ bearer: [] }], body: createSchema },
    },
    async (req, reply) => {
      const b = req.body;
      const slug = b.slug ?? `${slugify(b.name)}-${Date.now().toString(36).slice(-4)}`;
      const r = await pool
        .query<{ id: number }>(
          `INSERT INTO competitions (name, slug, description, starts_at, ends_at, starting_cash_paise, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [b.name, slug, b.description, b.startsAt, b.endsAt, b.startingCashRupees * 100, req.user!.id],
        )
        .catch((e: { code?: string }) => {
          if (e.code === '23505') throw new AppError(409, 'SLUG_TAKEN', 'That slug is already used');
          throw e;
        });
      reply.status(201);
      return { id: r.rows[0]!.id, slug };
    },
  );

  /** Joining creates a fresh wallet with the competition's starting cash, so everyone starts equal. */
  app.post(
    '/competitions/:id/join',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['competitions'],
        security: [{ bearer: [] }],
        params: z.object({ id: z.coerce.number().int() }),
      },
    },
    async (req) => {
      const accountId = await withTx(pool, async (c) => {
        const comp = (
          await c.query<{ ends_at: Date; starting_cash_paise: number }>(
            'SELECT ends_at, starting_cash_paise FROM competitions WHERE id = $1 FOR SHARE',
            [req.params.id],
          )
        ).rows[0];
        if (!comp) throw new AppError(404, 'NOT_FOUND', 'Competition not found');
        if (comp.ends_at <= new Date())
          throw new AppError(409, 'COMPETITION_CLOSED', 'This competition has ended');
        const existing = await c.query<{ id: number }>(
          'SELECT id FROM accounts WHERE user_id = $1 AND competition_id = $2',
          [req.user!.id, req.params.id],
        );
        if (existing.rows[0]) return existing.rows[0].id;
        return createAccount(c, req.user!.id, req.params.id, comp.starting_cash_paise);
      });
      return { accountId, competitionId: req.params.id };
    },
  );

  /** Ranked standings from the materialized view (refreshed every few seconds by the worker). */
  app.get(
    '/competitions/:id/leaderboard',
    {
      schema: {
        tags: ['competitions'],
        params: z.object({ id: z.coerce.number().int() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
    },
    async (req) => leaderboard(pool, req.params.id, req.query.limit, req.user?.id),
  );

  /** Everyday leaderboard across everyone's main practice wallet. */
  app.get(
    '/leaderboard',
    {
      schema: {
        tags: ['competitions'],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
    },
    async (req) => leaderboard(pool, null, req.query.limit, req.user?.id),
  );
};

// TODO(me) [Phase 7 task, ~30 min]: support ?sort=process on both leaderboard routes — order by avg_process_score
//   DESC (NULLs last) instead of rank, so a competition can also reward the best *habits*. Keep the RANK() column as is
//   and add a test in apps/api/test/competitions.test.ts. Bonus: a toggle on the /compete page.
async function leaderboard(pool: Pool, competitionId: number | null, limit: number, userId?: string) {
  const [top, me] = await Promise.all([
    pool.query(
      `SELECT * FROM mv_leaderboard WHERE competition_id IS NOT DISTINCT FROM $1 ORDER BY rank, account_id LIMIT $2`,
      [competitionId, limit],
    ),
    userId
      ? pool.query(
          `SELECT * FROM mv_leaderboard WHERE competition_id IS NOT DISTINCT FROM $1 AND user_id = $2`,
          [competitionId, userId],
        )
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);
  return {
    competitionId,
    refreshedAt: top.rows[0]?.refreshed_at ?? null,
    participants: Number(top.rows[0]?.participants ?? 0),
    rows: top.rows.map(leaderboardRow),
    me: me.rows[0] ? leaderboardRow(me.rows[0]) : null,
  };
}
