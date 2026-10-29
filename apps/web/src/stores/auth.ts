import { create } from 'zustand';
import type { User } from '@/lib/types';

interface AuthState {
  /** access token lives in memory only (never localStorage), the refresh token is an httpOnly cookie */
  accessToken: string | null;
  user: User | null;
  ready: boolean;
  setSession: (token: string, user: User) => void;
  clear: () => void;
  setReady: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  ready: false,
  setSession: (accessToken, user) => set({ accessToken, user }),
  clear: () => set({ accessToken: null, user: null }),
  setReady: () => set({ ready: true }),
}));
