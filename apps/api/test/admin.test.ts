import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import { config } from '@tradecore/shared/node';
import { buildApp, type App } from '../src/app';
import { createPrisma } from '../src/lib/prisma';
import { InProcessExchange, resetDb, seedInstrument, testPool } from './harness';

const SYM = 'BTC-INR';
const P = 71_50_000_00;
const pool = testPool();
const prisma = createPrisma('tradecore_test');
const redis = new Redis(config.redisUrl);
let app: App;
let ex: InProcessExchange;

async function login(role: 'USER' | 'ADMIN') {
  const email = `a${Date.now()}${Math.random()}@test.dev`;
  const reg = await request(app.server)
    .post('/api/auth/register')
    .send({ email, password: 'Passw0rd!', displayName: role === 'ADMIN' ? 'Ops' : 'Trader' })
    .expect(201);
  if (role === 'USER') return reg.body.accessToken as string;
  await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [reg.body.user.id]);
  const res = await request(app.server)
    .post('/api/auth/login')
    .send({ email, password: 'Passw0rd!' })
    .expect(200);
  return res.body.accessToken as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

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
  await pool.query('INSERT INTO engine_offsets (symbol) VALUES ($1) ON CONFLICT DO NOTHING', [SYM]);
  ex = new InProcessExchange(pool);
});

describe('admin', () => {
  it('is admin-only', async () => {
    const user = await login('USER');
    await request(app.server).get('/api/admin/overview').set(auth(user)).expect(403);
    await request(app.server).get('/api/admin/overview').expect(401);
  });

  it('halts trading through the engine; new orders are then refused; resume reopens it', async () => {
    const admin = await login('ADMIN');
    const trader = await login('USER');
    await request(app.server).post(`/api/admin/instruments/${SYM}/halt`).set(auth(admin)).expect(202);
    const st = (await pool.query('SELECT status FROM instruments WHERE symbol = $1', [SYM])).rows[0];
    expect(st.status).toBe('HALTED'); // recorded by settlement from the engine's HALTED event

    const order = { symbol: SYM, side: 'BUY', type: 'LIMIT', qty: 1, price: P };
    const r = await request(app.server).post('/api/orders').set(auth(trader)).send(order).expect(409);
    expect(r.body.error.code).toBe('HALTED');

    await request(app.server).post(`/api/admin/instruments/${SYM}/resume`).set(auth(admin)).expect(202);
    await request(app.server).post('/api/orders').set(auth(trader)).send(order).expect(202);
  });

  it('reports pipeline lag and runs the invariant checks on demand', async () => {
    const admin = await login('ADMIN');
    await login('USER');
    const o = await request(app.server).get('/api/admin/overview').set(auth(admin)).expect(200);
    expect(o.body.pipeline).toEqual([
      expect.objectContaining({ symbol: SYM, status: 'ACTIVE', settledSeq: 0 }),
    ]);
    expect(o.body.counts.users).toBeGreaterThanOrEqual(1);
    const inv = await request(app.server).post('/api/admin/invariants').set(auth(admin)).expect(200);
    expect(inv.body.ok).toBe(true);
  });
});
