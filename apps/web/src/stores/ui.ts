import { create } from 'zustand';

type Theme = 'dark' | 'light';

function readTheme(): Theme {
  try {
    return localStorage.getItem('tc-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

interface UiState {
  theme: Theme;
  symbol: string;
  /** side preselected in the order panel (keyboard B / S) */
  side: 'BUY' | 'SELL';
  orderFocusTick: number;
  /** price clicked in the order book, pushed into the order panel */
  prefill: { price: number; tick: number } | null;
  setPrefill: (price: number) => void;
  toggleTheme: () => void;
  setSymbol: (s: string) => void;
  focusOrder: (side: 'BUY' | 'SELL') => void;
}

export const useUi = create<UiState>((set, get) => ({
  theme: readTheme(),
  symbol: 'BTC-INR',
  side: 'BUY',
  orderFocusTick: 0,
  prefill: null,
  setPrefill: (price) => set((s) => ({ prefill: { price, tick: (s.prefill?.tick ?? 0) + 1 } })),
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('tc-theme', theme);
    } catch {
      /* storage blocked: theme still works for this session */
    }
    set({ theme });
  },
  setSymbol: (symbol) => set({ symbol }),
  focusOrder: (side) => set((s) => ({ side, orderFocusTick: s.orderFocusTick + 1 })),
}));
