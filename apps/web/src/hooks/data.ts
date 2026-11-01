import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/socket';
import type { Candle, Instrument, MyTrade, Order, Portfolio, TickerRow } from '@/lib/types';
import { useAuth } from '@/stores/auth';
import { useMarket, type TapeTrade } from '@/stores/market';
import { useUi } from '@/stores/ui';

/** Appends ?competitionId=… when the user is trading in a competition wallet. */
export function withAccount(path: string, competitionId: number | null): string {
  if (!competitionId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}competitionId=${competitionId}`;
}

export function useAccountContext() {
  return useUi((s) => s.competitionId);
}

export function useInstruments() {
  return useQuery({
    queryKey: ['instruments'],
    queryFn: () => api<Instrument[]>('/instruments'),
    staleTime: 60_000,
  });
}

export function useInstrument(symbol: string): Instrument | undefined {
  return useInstruments().data?.find((i) => i.symbol === symbol);
}

export function useTicker() {
  return useQuery({
    queryKey: ['ticker'],
    queryFn: () => api<TickerRow[]>('/market/ticker'),
    refetchInterval: 15_000,
  });
}

export function useCandles(symbol: string, tf: string) {
  return useQuery({
    queryKey: ['candles', symbol, tf],
    queryFn: () => api<Candle[]>(`/market/${symbol}/candles?tf=${tf}&limit=400`),
    refetchInterval: tf === '1m' ? 10_000 : 30_000,
  });
}

export function usePortfolio() {
  const authed = useAuth((s) => !!s.accessToken);
  const cid = useAccountContext();
  return useQuery({
    queryKey: ['portfolio', cid],
    queryFn: () => api<Portfolio>(withAccount('/portfolio', cid)),
    enabled: authed,
    refetchInterval: 15_000,
  });
}

export function useOrders(status: 'open' | 'all') {
  const authed = useAuth((s) => !!s.accessToken);
  const cid = useAccountContext();
  return useQuery({
    queryKey: ['orders', status, cid],
    queryFn: () => api<Order[]>(withAccount(`/orders?status=${status}&limit=200`, cid)),
    enabled: authed,
  });
}

export function useMyTrades() {
  const authed = useAuth((s) => !!s.accessToken);
  const cid = useAccountContext();
  return useQuery({
    queryKey: ['my-trades', cid],
    queryFn: () => api<MyTrade[]>(withAccount('/portfolio/trades?limit=200', cid)),
    enabled: authed,
  });
}

/** Subscribe this symbol's live book + trades while the component is mounted; seed the tape from REST. */
export function useSymbolStreams(symbol: string) {
  useEffect(() => {
    const offBook = subscribe('book', symbol);
    const offTrades = subscribe('trades', symbol);
    let alive = true;
    api<{ seq: number; price: number; qty: number; side: 'BUY' | 'SELL'; ts: string }[]>(
      `/market/${symbol}/trades?limit=60`,
    )
      .then((rows) => {
        if (!alive) return;
        const tape: TapeTrade[] = rows.map((r) => ({ ...r, ts: new Date(r.ts).getTime() }));
        useMarket.getState().addTrades(symbol, tape);
      })
      .catch(() => {});
    api<import('@/stores/market').Book>(`/market/${symbol}/book`)
      .then((b) => alive && useMarket.getState().setBook(b))
      .catch(() => {});
    return () => {
      alive = false;
      offBook();
      offTrades();
    };
  }, [symbol]);
}

export function useCompetitions() {
  return useQuery({
    queryKey: ['competitions'],
    queryFn: () => api<import('@/lib/types').Competition[]>('/competitions'),
    refetchInterval: 30_000,
  });
}
