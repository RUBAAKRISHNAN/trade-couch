import type { Server as HttpServer } from 'node:http';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import pino from 'pino';
import { channels } from '@tradecore/shared';
import { config, type Pool } from '@tradecore/shared/node';
import { verifyAccess } from './lib/auth';

const log = pino({ name: 'realtime', level: process.env.LOG_LEVEL ?? 'info' });

/**
 * WebSocket fan-out.
 *  - The engine/settler/feed publish to Redis; EVERY API instance subscribes and forwards to ITS OWN
 *    sockets (`io.local`), so N instances don't send N copies. The Redis adapter is still installed so
 *    server-wide emits (e.g. admin broadcasts) reach sockets on every instance.
 *  - Backpressure: book snapshots are already ≤10/s per symbol (engine throttles) and sent as
 *    `volatile` (dropped for a client whose buffer is full rather than queued forever). Trades are batched
 *    every 100 ms, tickers capped at 4/s per symbol, account pings at 5/s per user.
 */
export async function attachRealtime(httpServer: HttpServer, pool: Pool, redis: Redis) {
  const pubClient = new Redis(config.redisUrl, { connectionName: 'io-pub' });
  const subClient = pubClient.duplicate({ connectionName: 'io-sub' });
  const io = new Server(httpServer, {
    cors: { origin: config.webOrigin, credentials: true },
    adapter: createAdapter(pubClient, subClient),
    pingInterval: 20_000,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (token) {
      const claims = await verifyAccess(token).catch(() => undefined);
      if (claims) socket.data.userId = claims.sub;
    }
    next();
  });

  io.on('connection', (socket) => {
    if (socket.data.userId) void socket.join(`user:${socket.data.userId}`);
    void socket.join('ticker');
    socket.on('subscribe', (msg: { channel?: string; symbol?: string }) => {
      if (!msg?.symbol || !/^[A-Z0-9-]{2,32}$/.test(msg.symbol)) return;
      if (msg.channel === 'book' || msg.channel === 'trades')
        void socket.join(`${msg.channel}:${msg.symbol}`);
    });
    socket.on('unsubscribe', (msg: { channel?: string; symbol?: string }) => {
      if (msg?.channel && msg?.symbol) void socket.leave(`${msg.channel}:${msg.symbol}`);
    });
    socket.on('auth', async (token: string) => {
      const claims = await verifyAccess(token).catch(() => undefined);
      if (claims) {
        socket.data.userId = claims.sub;
        void socket.join(`user:${claims.sub}`);
      }
    });
  });

  // ── Redis → sockets
  const sub = new Redis(config.redisUrl, { connectionName: 'api-sub' });
  await sub.psubscribe('tc:book:*', 'tc:trades:*', 'tc:ref:*', channels.account);
  await sub.subscribe(channels.account);

  const tradeBuf = new Map<string, unknown[]>();
  const lastTicker = new Map<string, number>();
  const pendingTicker = new Map<string, unknown>();
  const acctOwner = new Map<number, string>();
  const lastAcctPing = new Map<string, number>();

  const ownerOf = async (accountId: number) => {
    let u = acctOwner.get(accountId);
    if (!u) {
      u = (await pool.query<{ user_id: string }>('SELECT user_id FROM accounts WHERE id = $1', [accountId]))
        .rows[0]?.user_id;
      if (u) acctOwner.set(accountId, u);
    }
    return u;
  };

  const onMessage = async (channel: string, message: string) => {
    if (channel.startsWith('tc:book:')) {
      io.local.volatile.to(`book:${channel.slice(8)}`).emit('book', JSON.parse(message));
    } else if (channel.startsWith('tc:trades:')) {
      const sym = channel.slice(10);
      const arr = tradeBuf.get(sym) ?? [];
      arr.push(...(JSON.parse(message) as unknown[]));
      tradeBuf.set(sym, arr);
    } else if (channel.startsWith('tc:ref:')) {
      const sym = channel.slice(7);
      pendingTicker.set(sym, { symbol: sym, ...JSON.parse(message) });
      if (Date.now() - (lastTicker.get(sym) ?? 0) >= 250) flushTicker(sym);
    } else if (channel === channels.account) {
      const { accountIds, symbol } = JSON.parse(message) as { accountIds: number[]; symbol: string };
      for (const id of accountIds) {
        const userId = await ownerOf(id);
        if (!userId) continue;
        const now = Date.now();
        if (now - (lastAcctPing.get(userId) ?? 0) < 200) continue;
        lastAcctPing.set(userId, now);
        io.local.to(`user:${userId}`).emit('account', { accountId: id, symbol });
      }
    }
  };
  const flushTicker = (sym: string) => {
    const t = pendingTicker.get(sym);
    if (!t) return;
    pendingTicker.delete(sym);
    lastTicker.set(sym, Date.now());
    io.local.volatile.to('ticker').emit('ticker', t);
  };
  sub.on(
    'pmessage',
    (_p, ch, msg) => void onMessage(ch, msg).catch((e) => log.warn({ err: e }, 'realtime message failed')),
  );
  sub.on(
    'message',
    (ch, msg) => void onMessage(ch, msg).catch((e) => log.warn({ err: e }, 'realtime message failed')),
  );

  const flushTimer = setInterval(() => {
    for (const [sym, arr] of tradeBuf)
      if (arr.length) io.local.to(`trades:${sym}`).emit('trades', arr.splice(0));
    for (const sym of pendingTicker.keys())
      if (Date.now() - (lastTicker.get(sym) ?? 0) >= 250) flushTicker(sym);
  }, 100);

  const healthTimer = setInterval(() => {
    void redis.hset(
      'tc:health:api',
      `${process.pid}`,
      JSON.stringify({ connections: io.engine.clientsCount, at: Date.now() }),
    );
  }, 2000);

  return {
    io,
    close: async () => {
      clearInterval(flushTimer);
      clearInterval(healthTimer);
      await new Promise<void>((r) => io.close(() => r()));
      sub.disconnect();
      pubClient.disconnect();
      subClient.disconnect();
    },
  };
}
