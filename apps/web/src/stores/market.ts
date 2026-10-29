import { create } from 'zustand';

export interface BookLevel {
  price: number;
  qty: number;
  orders: number;
}
export interface Book {
  symbol: string;
  seq: number;
  bids: BookLevel[];
  asks: BookLevel[];
  lastPrice?: number;
  markPrice?: number;
  halted: boolean;
  ts: number;
}
export interface TapeTrade {
  seq: number;
  price: number;
  qty: number;
  side: 'BUY' | 'SELL';
  ts: number;
}
export interface Tick {
  symbol: string;
  price: number;
  prev?: number;
  source: string;
  ts: number;
}
export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline';

interface MarketState {
  books: Record<string, Book>;
  tape: Record<string, TapeTrade[]>;
  ticks: Record<string, Tick>;
  conn: ConnState;
  setBook: (b: Book) => void;
  addTrades: (symbol: string, t: TapeTrade[]) => void;
  setTape: (symbol: string, t: TapeTrade[]) => void;
  setTick: (t: Omit<Tick, 'prev'>) => void;
  setConn: (c: ConnState) => void;
}

const TAPE_MAX = 80;

/**
 * High-frequency market state. Zustand lets each component subscribe to just the slice it renders
 * (e.g. one symbol's book), so a book update doesn't re-render the whole page.
 */
export const useMarket = create<MarketState>((set) => ({
  books: {},
  tape: {},
  ticks: {},
  conn: 'connecting',
  setBook: (b) => set((s) => ({ books: { ...s.books, [b.symbol]: b } })),
  addTrades: (symbol, t) =>
    set((s) => {
      const seen = new Set((s.tape[symbol] ?? []).map((x) => x.seq));
      const fresh = t.filter((x) => !seen.has(x.seq)).sort((a, b) => b.seq - a.seq);
      return { tape: { ...s.tape, [symbol]: [...fresh, ...(s.tape[symbol] ?? [])].slice(0, TAPE_MAX) } };
    }),
  setTape: (symbol, t) => set((s) => ({ tape: { ...s.tape, [symbol]: t.slice(0, TAPE_MAX) } })),
  setTick: (t) =>
    set((s) => ({ ticks: { ...s.ticks, [t.symbol]: { ...t, prev: s.ticks[t.symbol]?.price } } })),
  setConn: (conn) => set({ conn }),
}));
