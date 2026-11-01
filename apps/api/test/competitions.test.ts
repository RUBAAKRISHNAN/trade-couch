import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import { config } from '@tradecore/shared/node';
import { buildApp, type App } from '../src/app';
import { createPrisma } from '../src/lib/prisma';
import { placeOrder } from '../src/trading/orders';
import { InProcessExchange, makeUser, resetDb, seedInstrument, testPool } from './harness';

const SYM = 'BTC-INR';
const P = 71_50_000_00;
const pool = testPool();
const prisma = createPrisma('tradecore_test');
const redis = new Redis(config.redisUrl);
let app: App;
let ex: InProcessExchange;

async function register(name = 'Trader') {
  const email = `c${Date.now()}${Math.random()}@test.dev`;
  const res = await request(app.server)
    .post('/api/auth/register')
    .send({ email, password: 'Passw0rd!', displayName: name })
    .expect(201);
  return { token: res.body.accessToken as string, id: res.body.user.id as string, email };
}

async function admin() {
  const u = await register('Admin');
  await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [u.id]);
  const res = await request(app.server)
    .post('/api/auth/login')
    .send({ email: u.email, password: 'Passw0rd!' })
    .expect(200);
  return res.body.accessToken as string;
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function refreshViews() {
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_portfolio_summary');
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_leaderboard');
}

beforeAll(async () => {
  ex = new InProcessExchange(pool);
  app = await buildApp({ pool, prisma, redis, bus: { send: (s, c) => ex.send(s, c) } }, { rateLimit: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb();
  await seedInstrument(SYM, P);
  ex = new InProcessExchange(pool);
});

describe('competitions', () => {
  it('only admins create; joining gives everyone the same fresh wallet; leaderboard ranks by return', async () => {
    const asha = await register('Asha');
    const ravi = await register('Ravi');
    const body = {
      name: 'College Trading Week',
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      startingCashRupees: 50_000,
    };
    await request(app.server).post('/api/competitions').set(auth(asha.token)).send(body).expect(403);
    const adminToken = await admin();
    const created = await request(app.server)
      .post('/api/competitions')
      .set(auth(adminToken))
      .send(body)
      .expect(201);
    const id = created.body.id as number;

    const j1 = await request(app.server)
      .post(`/api/competitions/${id}/join`)
      .set(auth(asha.token))
      .expect(200);
    const again = await request(app.server)
      .post(`/api/competitions/${id}/join`)
      .set(auth(asha.token))
      .expect(200);
    expect(again.body.accountId).toBe(j1.body.accountId); // idempotent
    await request(app.server).post(`/api/competitions/${id}/join`).set(auth(ravi.token)).expect(200);
    const wallet = (await pool.query('SELECT cash_paise FROM accounts WHERE id = $1', [j1.body.accountId]))
      .rows[0];
    expect(wallet.cash_paise).toBe(50_000_00);

    // Asha buys 0.005 BTC (₹35,750) in her competition wallet from a bot, then the price rises 2%
    const bot = await makeUser({ units: { [SYM]: 1000 } });
    await pool.query(`UPDATE users SET role = 'BOT' WHERE id = $1`, [bot.userId]);
    await placeOrder(pool, ex, bot.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 100,
      price: P,
    });
    await request(app.server)
      .post('/api/orders')
      .set(auth(asha.token))
      .send({ symbol: SYM, side: 'BUY', type: 'LIMIT', qty: 50, price: P, competitionId: id })
      .expect(202);
    await pool.query('UPDATE market_prices SET ref_price_paise = $1', [P + (P / 100) * 2]);
    await refreshViews();

    const lb = await request(app.server)
      .get(`/api/competitions/${id}/leaderboard`)
      .set(auth(asha.token))
      .expect(200);
    expect(lb.body.participants).toBe(2);
    expect(lb.body.rows.map((r: { name: string; rank: number }) => [r.rank, r.name])).toEqual([
      [1, 'Asha'],
      [2, 'Ravi'],
    ]);
    expect(lb.body.rows[0].returnPct).toBeCloseTo((0.005 * P * 0.02 * 100) / 50_000_00, 3);
    expect(lb.body.me).toMatchObject({ rank: 1, name: 'Asha' });

    const list = await request(app.server).get('/api/competitions').set(auth(asha.token)).expect(200);
    expect(list.body[0]).toMatchObject({ id, status: 'LIVE', participants: 2, joined: true, myRank: 1 });

    // the practice leaderboard holds everyone's main wallet, never bots
    const practice = await request(app.server).get('/api/leaderboard').expect(200);
    expect(practice.body.rows.map((r: { name: string }) => r.name).sort()).toEqual(['Asha', 'Ravi']);
  });

  it('rejects joining or trading once a competition has ended', async () => {
    const u = await register();
    const c = await pool.query<{ id: number }>(
      `INSERT INTO competitions (name, slug, starts_at, ends_at, starting_cash_paise)
       VALUES ('Old cup', 'old-cup', now() - interval '2 days', now() + interval '1 hour', 1000000) RETURNING id`,
    );
    const id = c.rows[0]!.id;
    await request(app.server).post(`/api/competitions/${id}/join`).set(auth(u.token)).expect(200);
    await pool.query(`UPDATE competitions SET ends_at = now() - interval '1 minute' WHERE id = $1`, [id]);

    const r = await request(app.server)
      .post('/api/orders')
      .set(auth(u.token))
      .send({ symbol: SYM, side: 'BUY', type: 'LIMIT', qty: 1, price: P, competitionId: id })
      .expect(409);
    expect(r.body.error.code).toBe('COMPETITION_CLOSED');
    const u2 = await register();
    await request(app.server).post(`/api/competitions/${id}/join`).set(auth(u2.token)).expect(409);
  });
});
