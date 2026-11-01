import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import { config } from '@tradecore/shared/node';
import { buildApp, type App } from '../src/app';
import { createPrisma } from '../src/lib/prisma';
import { InProcessExchange, resetDb, seedInstrument, testPool } from './harness';

const pool = testPool();
const prisma = createPrisma('tradecore_test');
const redis = new Redis(config.redisUrl);
const P = 71_50_000_00;
let app: App;
let ex: InProcessExchange;

function cookieFrom(res: request.Response) {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith('tc_rt='))?.split(';')[0];
}

async function register(email = `u${Date.now()}${Math.random()}@test.dev`) {
  const res = await request(app.server)
    .post('/api/auth/register')
    .send({ email, password: 'Passw0rd!', displayName: 'Test User' })
    .expect(201);
  return { token: res.body.accessToken as string, cookie: cookieFrom(res)!, email };
}

beforeAll(async () => {
  ex = new InProcessExchange(pool);
  // the app keeps one bus; each test swaps in a fresh in-process exchange behind it
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
  await seedInstrument('BTC-INR', P);
  ex = new InProcessExchange(pool);
});

describe('auth', () => {
  it('registers with ₹1,00,000 virtual cash and returns a working access token', async () => {
    const u = await register();
    expect(u.cookie).toMatch(/^tc_rt=/);
    const me = await request(app.server)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${u.token}`)
      .expect(200);
    expect(me.body.accounts).toHaveLength(1);
    expect(me.body.accounts[0].starting_cash_paise).toBe(1_00_000_00);
  });

  it('rejects duplicate emails, bad passwords, and missing tokens', async () => {
    const u = await register();
    await request(app.server)
      .post('/api/auth/register')
      .send({ email: u.email, password: 'Passw0rd!', displayName: 'Again' })
      .expect(409);
    await request(app.server)
      .post('/api/auth/login')
      .send({ email: u.email, password: 'wrong-pass1' })
      .expect(401);
    await request(app.server)
      .post('/api/auth/register')
      .send({ email: 'x@y.z', password: 'short', displayName: 'Ab' })
      .expect(400);
    await request(app.server).get('/api/auth/me').expect(401);
    await request(app.server).get('/api/auth/me').set('authorization', 'Bearer not-a-jwt').expect(401);
  });

  it('rotates the refresh token and detects reuse (revoking the whole family)', async () => {
    const u = await register();
    const r1 = await request(app.server).post('/api/auth/refresh').set('cookie', u.cookie).expect(200);
    const c2 = cookieFrom(r1)!;
    expect(c2).not.toEqual(u.cookie);
    // replaying the OLD token = reuse → 401, and the new token is revoked too
    const reuse = await request(app.server).post('/api/auth/refresh').set('cookie', u.cookie).expect(401);
    expect(reuse.body.error.code).toBe('TOKEN_REUSE');
    await request(app.server).post('/api/auth/refresh').set('cookie', c2).expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const u = await register();
    await request(app.server).post('/api/auth/logout').set('cookie', u.cookie).expect(200);
    await request(app.server).post('/api/auth/refresh').set('cookie', u.cookie).expect(401);
  });
});

describe('orders over HTTP', () => {
  it('places, lists and cancels an order; holds follow', async () => {
    const u = await register();
    const auth = { authorization: `Bearer ${u.token}` };
    const placed = await request(app.server)
      .post('/api/orders')
      .set(auth)
      .send({
        symbol: 'BTC-INR',
        side: 'BUY',
        type: 'LIMIT',
        qty: 10,
        price: P - 1_000_000,
        planStopPrice: P - 5_000_000,
      })
      .expect(202);
    expect(placed.body).toMatchObject({
      symbol: 'BTC-INR',
      side: 'BUY',
      status: 'PENDING',
      planStop: P - 5_000_000,
    });
    const open = await request(app.server).get('/api/orders').set(auth).expect(200);
    expect(open.body).toHaveLength(1);
    expect(open.body[0].status).toBe('OPEN');
    let pf = await request(app.server).get('/api/portfolio').set(auth).expect(200);
    expect(pf.body.cashHeld).toBe(10 * ((P - 1_000_000) / 10_000));
    await request(app.server).delete(`/api/orders/${placed.body.id}`).set(auth).expect(202);
    pf = await request(app.server).get('/api/portfolio').set(auth).expect(200);
    expect(pf.body.cashHeld).toBe(0);
    expect(pf.body.equity).toBe(1_00_000_00);
  });

  it('validates orders with clear messages', async () => {
    const u = await register();
    const auth = { authorization: `Bearer ${u.token}` };
    const r = await request(app.server)
      .post('/api/orders')
      .set(auth)
      .send({ symbol: 'BTC-INR', side: 'BUY', type: 'LIMIT', qty: 1 })
      .expect(400);
    expect(r.body.error.code).toBe('VALIDATION');
    const tick = await request(app.server)
      .post('/api/orders')
      .set(auth)
      .send({ symbol: 'BTC-INR', side: 'BUY', type: 'LIMIT', qty: 1, price: P + 1 })
      .expect(400);
    expect(tick.body.error.code).toBe('BAD_TICK');
    const poor = await request(app.server)
      .post('/api/orders')
      .set(auth)
      .send({ symbol: 'BTC-INR', side: 'BUY', type: 'LIMIT', qty: 10_000, price: P })
      .expect(422);
    expect(poor.body.error.code).toBe('INSUFFICIENT_FUNDS');
    await request(app.server)
      .post('/api/orders')
      .send({ symbol: 'BTC-INR', side: 'BUY', type: 'LIMIT', qty: 1, price: P })
      .expect(401);
  });

  it('cannot cancel someone else’s order', async () => {
    const a = await register();
    const b = await register();
    const o = await request(app.server)
      .post('/api/orders')
      .set({ authorization: `Bearer ${a.token}` })
      .send({ symbol: 'BTC-INR', side: 'BUY', type: 'LIMIT', qty: 1, price: P })
      .expect(202);
    await request(app.server)
      .delete(`/api/orders/${o.body.id}`)
      .set({ authorization: `Bearer ${b.token}` })
      .expect(404);
  });

  it('serves instruments, candles (window functions) and an OpenAPI document', async () => {
    const inst = await request(app.server).get('/api/instruments').expect(200);
    expect(inst.body[0]).toMatchObject({ symbol: 'BTC-INR', qtyScale: 10_000 });
    const c = await request(app.server).get('/api/market/BTC-INR/candles?tf=1m').expect(200);
    expect(Array.isArray(c.body)).toBe(true);
    const doc = await request(app.server).get('/docs/json').expect(200);
    expect(Object.keys(doc.body.paths)).toContain('/api/orders/');
    const health = await request(app.server).get('/api/health').expect(200);
    expect(health.body).toMatchObject({ ok: true, db: true, redis: true });
  });
});

describe('rate limiting', () => {
  it('limits auth attempts per client (Redis-backed)', async () => {
    // own key prefix: this test must not fill (or wipe) the login counters of an app running on this machine
    const ns = `tc:test:rl:${Date.now().toString(36)}:`;
    const limited = await buildApp({ pool, prisma, redis, bus: ex }, { rateLimitNamespace: ns });
    await limited.ready();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++)
      codes.push(
        (
          await request(limited.server)
            .post('/api/auth/login')
            .send({ email: 'nobody@test.dev', password: 'whatever1' })
        ).status,
      );
    expect(codes.filter((c) => c === 401)).toHaveLength(20);
    expect(codes.slice(-2)).toEqual([429, 429]);
    await limited.close();
    const keys = await redis.keys(`${ns}*`);
    if (keys.length) await redis.del(...keys);
  });
});
