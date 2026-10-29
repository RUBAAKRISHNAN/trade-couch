import { NavLink, Outlet, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  BookOpen,
  GraduationCap,
  LogOut,
  Moon,
  ShieldCheck,
  Sun,
  Trophy,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Tip } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useMarket } from '@/stores/market';
import { useUi } from '@/stores/ui';

const NAV = [
  { to: '/trade', label: 'Trade', icon: BarChart3 },
  { to: '/portfolio', label: 'Portfolio', icon: Wallet },
  { to: '/coach', label: 'Coach', icon: GraduationCap },
  { to: '/compete', label: 'Compete', icon: Trophy },
  { to: '/learn', label: 'Learn', icon: BookOpen },
];

export function Disclaimer({ className }: { className?: string }) {
  return (
    <p className={cn('text-[11px] text-muted', className)} role="note">
      <span className="font-semibold text-warn">Virtual money</span> · For learning only · Not investment
      advice
    </p>
  );
}

function ConnectionDot() {
  const conn = useMarket((s) => s.conn);
  const map = {
    live: ['bg-buy', 'Live'],
    connecting: ['bg-warn animate-pulse', 'Connecting…'],
    reconnecting: ['bg-warn animate-pulse', 'Reconnecting…'],
    offline: ['bg-sell', 'Offline'],
  } as const;
  const [color, label] = map[conn];
  return (
    <Tip
      content={
        conn === 'live'
          ? 'Real-time connection is healthy'
          : 'Live updates paused — we keep retrying automatically'
      }
    >
      <span className="flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
        <span className={cn('size-2 rounded-full', color)} />
        <span className="hidden sm:inline">{label}</span>
      </span>
    </Tip>
  );
}

export function AppShell() {
  const user = useAuth((s) => s.user);
  const { theme, toggleTheme } = useUi();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    useAuth.getState().clear();
    qc.clear();
    navigate('/login');
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-panel px-3">
        <NavLink
          to="/trade"
          className="flex items-center gap-2 font-semibold tracking-tight"
          aria-label="TradeCore home"
        >
          <img src="/favicon.svg" alt="" className="size-6" />
          <span>TradeCore</span>
        </NavLink>
        <Badge variant="warn" className="hidden md:inline-flex">
          Virtual money
        </Badge>
        <nav className="ml-2 hidden items-center gap-0.5 md:flex" aria-label="Main">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-foreground',
                  isActive && 'bg-panel-2 text-foreground',
                )
              }
            >
              <n.icon className="size-4" />
              {n.label}
            </NavLink>
          ))}
          {user?.role === 'ADMIN' && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:text-foreground',
                  isActive && 'bg-panel-2 text-foreground',
                )
              }
            >
              <ShieldCheck className="size-4" />
              Admin
            </NavLink>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ConnectionDot />
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
          {user && (
            <>
              <span className="hidden text-sm text-muted sm:inline">{user.displayName}</span>
              <Button variant="ghost" size="icon" onClick={logout} aria-label="Log out">
                <LogOut />
              </Button>
            </>
          )}
        </div>
      </header>
      <div className="flex shrink-0 items-center justify-center border-b bg-warn/5 px-3 py-1">
        <Disclaimer />
      </div>
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
      {/* mobile bottom navigation */}
      <nav className="grid shrink-0 grid-cols-5 border-t bg-panel md:hidden" aria-label="Main mobile">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) =>
              cn('flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted', isActive && 'text-accent')
            }
          >
            <n.icon className="size-4" />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
