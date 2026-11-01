import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import { config } from '@tradecore/shared/node';
import { buildApp, type App } from '../src/app';
import { createPrisma } from '../src/lib/prisma';
import {
  buildChatRequest,
  buildTraderContext,
  GeminiError,
  GeminiProvider,
  parseGeminiSse,
  type ChatMessage,
  type ChatProvider,
} from '../src/coach/chat';
import { placeOrder } from '../src/trading/orders';
import { runCoach } from '../src/coach/coach';
import { InProcessExchange, makeUser, resetDb, seedInstrument, testPool } from './harness';

const SYM = 'BTC-INR';
const P = 95_00_000_00;
const pool = testPool();

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
const sseEvent = (text: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] })}\r\n\r\n`;

async function collect(it: AsyncIterable<string>) {
  let s = '';
  for await (const t of it) s += t;
  return s;
}

describe('Gemini streaming', () => {
  it('parses SSE text deltas, even when events are split across network chunks', async () => {
    const body = sseEvent('Hello ') + sseEvent('**Asha**') + sseEvent('!');
    const chunks = [body.slice(0, 17), body.slice(17, 90), body.slice(90)];
    expect(await collect(parseGeminiSse(streamOf(chunks)))).toBe('Hello **Asha**!');
  });

  it('sends the system prompt, roles and the key in a header (never in the URL)', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(streamOf([sseEvent('ok')]), { status: 200 });
    }) as unknown as typeof fetch;
    const g = new GeminiProvider('secret-key', 'gemini-test', fakeFetch);
    const msgs: ChatMessage[] = [
      { role: 'user', text: 'hi' },
      { role: 'model', text: 'hello' },
      { role: 'user', text: 'how am I doing?' },
    ];
    expect(await collect(g.stream('SYSTEM', msgs))).toBe('ok');
    expect(seen!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
    );
    expect(seen!.url).not.toContain('secret-key');
    expect((seen!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
    const body = JSON.parse(seen!.init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYSTEM' }] });
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('turns an HTTP error into a GeminiError with the API message', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'API key not valid' } }), {
        status: 400,
      })) as unknown as typeof fetch;
    const g = new GeminiProvider('bad', 'gemini-test', fakeFetch);
    await expect(collect(g.stream('S', [{ role: 'user', text: 'x' }]))).rejects.toMatchObject({
      status: 400,
      detail: 'API key not valid',
    });
    expect(new GeminiError(429, '').message).toBe('Gemini API error 429');
  });
});

describe('Gemini model fallback', () => {
  const urlsOf = (calls: string[]) => calls.map((u) => u.match(/models\/([^:]+):/)![1]);

  it('moves to the next model when one never answers or is overloaded, and stops at a bad key', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes('/slow:'))
        return new Promise((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      if (url.includes('/busy:')) return new Response('{}', { status: 503 });
      return new Response(streamOf([sseEvent('answer')]), { status: 200 });
    }) as unknown as typeof fetch;

    const g = new GeminiProvider('k', ['slow', 'busy', 'good'], fakeFetch, { headerTimeoutMs: 50 });
    expect(await collect(g.stream('S', [{ role: 'user', text: 'x' }]))).toBe('answer');
    expect(urlsOf(calls)).toEqual(['slow', 'busy', 'good']);
    expect(g.lastModel).toBe('good');

    // a rejected key won't work on any model: fail fast instead of trying them all
    calls.length = 0;
    const badKey = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      collect(new GeminiProvider('bad', ['a', 'b'], badKey).stream('S', [{ role: 'user', text: 'x' }])),
    ).rejects.toMatchObject({ status: 400 });
    expect(urlsOf(calls)).toEqual(['a']);
  });

  it('reports the last failure when every model fails', async () => {
    const busy = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    await expect(
      collect(new GeminiProvider('k', ['a', 'b'], busy).stream('S', [{ role: 'user', text: 'x' }])),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('coach chat (Postgres + API)', () => {
  const prisma = createPrisma('tradecore_test');
  const redis = new Redis(config.redisUrl);
  let app: App;
  let appNoAi: App;
  let ex: InProcessExchange;
  let lastRequest: ChatMessage[] = [];
  const fake: ChatProvider = {
    name: 'fake',
    async *stream(_system, messages) {
      lastRequest = messages;
      yield 'You did ';
      yield 'well.';
    },
  };

  beforeAll(async () => {
    ex = new InProcessExchange(pool);
    const bus = { send: (s: string, c: Parameters<InProcessExchange['send']>[1]) => ex.send(s, c) };
    app = await buildApp({ pool, prisma, redis, bus, chat: fake }, { rateLimit: false });
    appNoAi = await buildApp({ pool, prisma, redis, bus }, { rateLimit: false });
    await Promise.all([app.ready(), appNoAi.ready()]);
  });
  afterAll(async () => {
    await Promise.all([app.close(), appNoAi.close()]);
    await prisma.$disconnect();
    redis.disconnect();
  });
  beforeEach(async () => {
    await resetDb();
    await seedInstrument(SYM, P);
    ex = new InProcessExchange(pool);
  });

  async function traderWithOneTrip() {
    const reg = await request(app.server)
      .post('/api/auth/register')
      .send({
        email: `chat${Date.now()}${Math.random()}@test.dev`,
        password: 'Passw0rd!',
        displayName: 'Chat Tester',
      })
      .expect(201);
    const accountId = (await pool.query('SELECT id FROM accounts WHERE user_id = $1', [reg.body.user.id]))
      .rows[0].id;
    const bot = await makeUser({ units: { [SYM]: 100 } });
    await pool.query(`UPDATE users SET role = 'BOT' WHERE id = $1`, [bot.userId]);
    await placeOrder(pool, ex, bot.accountId, {
      symbol: SYM,
      side: 'SELL',
      type: 'LIMIT',
      qty: 10,
      price: P,
    });
    await placeOrder(pool, ex, accountId, { symbol: SYM, side: 'BUY', type: 'LIMIT', qty: 10, price: P });
    await placeOrder(pool, ex, bot.accountId, { symbol: SYM, side: 'BUY', type: 'LIMIT', qty: 10, price: P });
    await placeOrder(pool, ex, accountId, { symbol: SYM, side: 'SELL', type: 'LIMIT', qty: 10, price: P });
    await runCoach(pool);
    return { token: reg.body.accessToken as string, accountId, email: reg.body.user.email as string };
  }

  it('builds a factual trader summary with grades and habits, and no personal details', async () => {
    const t = await traderWithOneTrip();
    const ctx = await buildTraderContext(pool, t.accountId);
    expect(ctx).toContain('Graded round trips (buy → sell back to zero): 1.');
    expect(ctx).toMatch(/PROBLEM · No stop-loss: 1/);
    expect(ctx).toMatch(/BTC-INR closed .* grade [A-F]/);
    expect(ctx).not.toContain(t.email);
    expect(ctx).not.toContain('Chat Tester');
    // the data rides on the first user message only
    const req = buildChatRequest(ctx, [
      { role: 'user', text: 'first' },
      { role: 'model', text: 'answer' },
      { role: 'user', text: 'second' },
    ]);
    expect(req[0]!.text).toMatch(/^<trader_data>[\s\S]*<\/trader_data>\n\nfirst$/);
    expect(req[2]!.text).toBe('second');
  });

  it('streams the reply as server-sent events', async () => {
    const t = await traderWithOneTrip();
    const res = await request(app.server)
      .post('/api/coach/chat')
      .set('authorization', `Bearer ${t.token}`)
      .send({ messages: [{ role: 'user', text: 'Where am I losing money?' }] })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = res.text
      .split('\n\n')
      .filter(Boolean)
      .map((e) => JSON.parse(e.replace(/^data: /, '')));
    expect(events).toEqual([{ text: 'You did ' }, { text: 'well.' }, { done: true }]);
    expect(lastRequest[0]!.text).toContain('<trader_data>');
    expect(lastRequest[0]!.text).toContain('Where am I losing money?');
  });

  it('reports chat status and refuses cleanly when no API key is configured', async () => {
    const t = await traderWithOneTrip();
    const auth = { authorization: `Bearer ${t.token}` };
    expect((await request(app.server).get('/api/coach/chat/status').set(auth)).body).toEqual({
      enabled: true,
      model: 'fake',
    });
    expect((await request(appNoAi.server).get('/api/coach/chat/status').set(auth)).body).toEqual({
      enabled: false,
      model: null,
    });
    const r = await request(appNoAi.server)
      .post('/api/coach/chat')
      .set(auth)
      .send({ messages: [{ role: 'user', text: 'hi' }] })
      .expect(503);
    expect(r.body.error.code).toBe('AI_DISABLED');
    // the last message must come from the user
    await request(app.server)
      .post('/api/coach/chat')
      .set(auth)
      .send({ messages: [{ role: 'model', text: 'hi' }] })
      .expect(400);
  });
});
