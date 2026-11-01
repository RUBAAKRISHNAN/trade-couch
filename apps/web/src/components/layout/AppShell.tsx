import { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  BookOpen,
  GraduationCap,
  LogOut,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  Trophy,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/primitives';
import { CoachSheet } from '@/features/coach/CoachChat';
import { useCompetitions } from '@/hooks/data';
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

/** Which wallet the app trades with: the main practice wallet or a joined, live competition wallet. */
function WalletSwitcher() {
  const { competitionId, setCompetitionId } = useUi();
  const comps = useCompetitions().data;
  const joined = comps?.filter((c) => c.joined && c.status === 'LIVE') ?? [];
  const qc = useQueryClient();
  const stale = !!comps && !!competitionId && !joined.some((c) => c.id === competitionId);
  // a competition that ended falls back to the practice wallet
  useEffect(() => {
    if (stale) setCompetitionId(null);
  }, [stale, setCompetitionId]);
  if (!joined.length) return null;
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <Wallet className="size-3.5" />
      <span className="sr-only">Active wallet</span>
      <select
        value={competitionId ?? ''}
        onChange={(e) => {
          setCompetitionId(e.target.value ? Number(e.target.value) : null);
          void qc.invalidateQueries();
        }}
        className="h-7 max-w-40 rounded-md border bg-panel-2 px-1.5 text-xs text-foreground"
      >
        <option value="">Practice wallet</option>
        {joined.map((c) => (
          <option key={c.id} value={c.id}>
            🏆 {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AppShell() {
  const user = useAuth((s) => s.user);
  const { theme, toggleTheme, setCoachOpen } = useUi();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    useAuth.getState().clear();
    qc.clear();
    navigate('/login');
  };

  const navItem = ({ isActive }: { isActive: boolean }) =>
    cn(
      'relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-panel-2/60 hover:text-foreground',
      isActive &&
        'bg-accent/12 text-foreground after:absolute after:inset-x-2.5 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-brand',
    );
  const navLinks = [
    ...NAV,
    ...(user?.role === 'ADMIN' ? [{ to: '/admin', label: 'Admin', icon: ShieldCheck }] : []),
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b bg-panel/70 px-3 backdrop-blur-xl sm:px-4">
        <NavLink to="/trade" className="flex items-center gap-2" aria-label="TradeCore home">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="text-brand hidden text-[17px] font-bold tracking-tight sm:inline">TradeCore</span>
        </NavLink>
        <Tip content="Virtual money · For learning only · Not investment advice">
          <span className="hidden cursor-help rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn md:inline">
            Virtual
          </span>
        </Tip>
        <nav className="ml-1 hidden items-center gap-1 md:flex" aria-label="Main">
          {navLinks.map((n) => (
            <NavLink key={n.to} to={n.to} className={navItem}>
              <n.icon className="size-4" />
              <span className="hidden lg:inline">{n.label}</span>
              <span className="sr-only lg:hidden">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <WalletSwitcher />
          <ConnectionDot />
          <button
            type="button"
            onClick={() => setCoachOpen(true)}
            className="bg-brand flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-white shadow-[0_6px_20px_-8px_var(--accent)] transition hover:brightness-110 active:scale-[0.98]"
          >
            <Sparkles className="size-4" />
            <span className="hidden sm:inline">AI Coach</span>
            <span className="sr-only sm:hidden">AI Coach</span>
          </button>
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
              <Tip content={user.displayName}>
                <span
                  className="hidden size-8 place-items-center rounded-full bg-panel-2 text-xs font-semibold sm:grid"
                  aria-label={`Signed in as ${user.displayName}`}
                >
                  {user.displayName.slice(0, 1).toUpperCase()}
                </span>
              </Tip>
              <Button variant="ghost" size="icon" onClick={logout} aria-label="Log out">
                <LogOut />
              </Button>
            </>
          )}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      {/* mobile bottom navigation */}
      <nav
        className="grid shrink-0 grid-cols-5 border-t bg-panel/90 backdrop-blur-xl md:hidden"
        aria-label="Main mobile"
      >
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) =>
              cn('flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted', isActive && 'text-accent')
            }
          >
            <n.icon className="size-5" />
            {n.label}
          </NavLink>
        ))}
      </nav>
      <CoachSheet />
    </div>
  );
}
