import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { Skeleton } from '@/components/ui/primitives';
import { refreshSession } from '@/lib/api';
import { connectSocket } from '@/lib/socket';
import { useAuth } from '@/stores/auth';
import { LoginPage, RegisterPage } from '@/features/auth/AuthPages';
import { TradePage } from '@/features/trade/TradePage';

const PortfolioPage = lazy(() => import('@/features/portfolio/PortfolioPage'));
const ComingSoon = lazy(() => import('@/features/ComingSoon'));
const CoachPage = lazy(() => import('@/features/coach/CoachPage'));
const CompetePage = lazy(() => import('@/features/compete/CompetePage'));

function Protected({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <PageSkeleton />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return children;
}

function PageSkeleton() {
  return (
    <div className="grid h-full gap-2 p-2 md:grid-cols-[220px_1fr_300px]" aria-busy>
      <Skeleton className="hidden h-full md:block" />
      <Skeleton className="h-full min-h-80" />
      <Skeleton className="hidden h-full md:block" />
    </div>
  );
}

export function App({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    // restore the session from the httpOnly refresh cookie, then open the realtime connection
    void refreshSession().finally(() => {
      useAuth.getState().setReady();
      connectSocket(queryClient);
    });
  }, [queryClient]);

  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          element={
            <Protected>
              <AppShell />
            </Protected>
          }
        >
          <Route path="/trade" element={<TradePage />} />
          <Route path="/trade/:symbol" element={<TradePage />} />
          <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/coach" element={<CoachPage />} />
          <Route path="/compete" element={<CompetePage />} />
          <Route path="/learn" element={<ComingSoon title="Learn" />} />
          <Route path="/admin" element={<ComingSoon title="Admin" />} />
        </Route>
        <Route path="*" element={<Navigate to="/trade" replace />} />
      </Routes>
    </Suspense>
  );
}
