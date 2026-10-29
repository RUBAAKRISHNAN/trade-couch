import { io, type Socket } from 'socket.io-client';
import type { QueryClient } from '@tanstack/react-query';
import { useAuth } from '@/stores/auth';
import { useMarket, type Book, type TapeTrade } from '@/stores/market';

let socket: Socket | null = null;
const subs = new Map<string, number>(); // "book:BTC-INR" → ref count

/**
 * One shared Socket.io connection. Streams:
 *  - ticker  (reference prices, ≤4/s per symbol)  → market store
 *  - book    (order book snapshots, ≤10/s)       → market store
 *  - trades  (batched every 100 ms)               → market store
 *  - account (my orders/balances changed)         → refetch portfolio & orders
 */
export function connectSocket(qc: QueryClient): Socket {
  if (socket) return socket;
  const url = (import.meta.env.VITE_API_URL as string | undefined) ?? undefined;
  const s = io(url ?? '/', {
    path: '/socket.io',
    transports: ['websocket'],
    auth: (cb) => cb({ token: useAuth.getState().accessToken }),
  });
  socket = s;
  const m = useMarket.getState();

  s.on('connect', () => {
    m.setConn('live');
    for (const key of subs.keys()) {
      const [channel, symbol] = key.split(':');
      s.emit('subscribe', { channel, symbol });
    }
  });
  s.on('disconnect', () => m.setConn('reconnecting'));
  s.io.on('reconnect_attempt', () => m.setConn('reconnecting'));
  s.io.on('reconnect_failed', () => m.setConn('offline'));
  s.on('connect_error', () => m.setConn(navigator.onLine ? 'reconnecting' : 'offline'));

  s.on('ticker', (t: { symbol: string; price: number; source: string; ts: number }) =>
    useMarket.getState().setTick(t),
  );
  s.on('book', (b: Book) => useMarket.getState().setBook(b));
  s.on('trades', (msg: { symbol: string; trades: TapeTrade[] }) => {
    if (msg.trades.length) useMarket.getState().addTrades(msg.symbol, msg.trades);
  });

  let pending: ReturnType<typeof setTimeout> | null = null;
  s.on('account', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['my-trades'] });
    }, 150);
  });

  // re-authenticate the socket whenever the access token changes (login / refresh)
  useAuth.subscribe((st, prev) => {
    if (st.accessToken && st.accessToken !== prev.accessToken) s.emit('auth', st.accessToken);
  });
  return s;
}

export function subscribe(channel: 'book' | 'trades', symbol: string) {
  const key = `${channel}:${symbol}`;
  subs.set(key, (subs.get(key) ?? 0) + 1);
  socket?.emit('subscribe', { channel, symbol });
  return () => {
    const n = (subs.get(key) ?? 1) - 1;
    if (n <= 0) {
      subs.delete(key);
      socket?.emit('unsubscribe', { channel, symbol });
    } else subs.set(key, n);
  };
}
