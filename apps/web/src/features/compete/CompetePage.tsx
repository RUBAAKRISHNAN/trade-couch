import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { CalendarClock, Crown, Medal, Trophy, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton, Tip } from '@/components/ui/primitives';
import { useCompetitions } from '@/hooks/data';
import { api, ApiError } from '@/lib/api';
import { inr, pct, signedInr } from '@/lib/format';
import type { Competition, Leaderboard } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';

const STATUS: Record<Competition['status'], { label: string; variant: 'buy' | 'warn' | 'default' }> = {
  LIVE: { label: 'Live', variant: 'buy' },
  UPCOMING: { label: 'Upcoming', variant: 'warn' },
  ENDED: { label: 'Ended', variant: 'default' },
};

const fmtDate = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function timeLeft(c: Competition) {
  const ms = new Date(c.status === 'UPCOMING' ? c.startsAt : c.endsAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  const label = d >= 1 ? `${d}d ${h % 24}h` : `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return c.status === 'UPCOMING' ? `starts in ${label}` : `${label} left`;
}

function RankIcon({ rank }: { rank: number }) {
  if (rank === 1) return <Crown className="size-4 text-warn" aria-label="1st" />;
  if (rank <= 3)
    return (
      <Medal className={cn('size-4', rank === 2 ? 'text-muted' : 'text-[#c98a4b]')} aria-label={`${rank}`} />
    );
  return <span className="num text-xs text-muted">{rank}</span>;
}

function LeaderboardTable({ competitionId }: { competitionId: number | null }) {
  const userId = useAuth((s) => s.user?.id);
  const q = useQuery({
    queryKey: ['leaderboard', competitionId],
    queryFn: () =>
      api<Leaderboard>(
        competitionId ? `/competitions/${competitionId}/leaderboard?limit=100` : '/leaderboard?limit=100',
      ),
    refetchInterval: 10_000,
  });
  if (q.isLoading) return <Skeleton className="h-64" />;
  const lb = q.data;
  if (!lb?.rows.length)
    return <p className="p-6 text-center text-sm text-muted">No one is ranked yet. Be the first to trade!</p>;
  const meInTop = lb.rows.some((r) => r.userId === userId);
  const rows = meInTop || !lb.me ? lb.rows : [...lb.rows, lb.me];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
          <tr className="border-b">
            <th className="w-12 px-3 py-2">#</th>
            <th className="px-3 py-2">Trader</th>
            <th className="px-3 py-2 text-right">Return</th>
            <th className="hidden px-3 py-2 text-right sm:table-cell">P&amp;L</th>
            <th className="hidden px-3 py-2 text-right md:table-cell">Equity</th>
            <th className="px-3 py-2 text-right">
              <Tip content="Average Trade Coach process score (0–100). Winning with good habits is what counts.">
                <span className="cursor-help underline decoration-dotted">Process</span>
              </Tip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const me = r.userId === userId;
            return (
              <motion.tr
                key={r.accountId}
                layout
                className={cn(
                  'border-b last:border-0',
                  me && 'bg-accent/10',
                  !meInTop && i === rows.length - 1 && me && 'border-t-2 border-t-accent/40',
                )}
              >
                <td className="px-3 py-2">
                  <RankIcon rank={r.rank} />
                </td>
                <td className="px-3 py-2 font-medium">
                  {r.name} {me && <Badge variant="accent">You</Badge>}
                  <span className="block text-[11px] font-normal text-muted">{r.roundTrips} round trips</span>
                </td>
                <td
                  className={cn(
                    'num px-3 py-2 text-right font-semibold',
                    r.returnPct >= 0 ? 'text-buy' : 'text-sell',
                  )}
                >
                  {pct(r.returnPct)}
                </td>
                <td
                  className={cn(
                    'num hidden px-3 py-2 text-right sm:table-cell',
                    r.pnl >= 0 ? 'text-buy' : 'text-sell',
                  )}
                >
                  {signedInr(r.pnl)}
                </td>
                <td className="num hidden px-3 py-2 text-right md:table-cell">
                  {inr(r.equity, { noDecimals: true })}
                </td>
                <td className="num px-3 py-2 text-right">{r.avgProcessScore ?? '—'}</td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
      {lb.refreshedAt && (
        <p className="px-3 py-2 text-[11px] text-muted">
          {lb.participants} traders · updated {new Date(lb.refreshedAt).toLocaleTimeString('en-IN')}
        </p>
      )}
    </div>
  );
}

export default function CompetePage() {
  const { data: comps, isLoading } = useCompetitions();
  const { competitionId, setCompetitionId } = useUi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<number | null | undefined>(undefined);

  const join = useMutation({
    mutationFn: (id: number) => api<{ accountId: number }>(`/competitions/${id}/join`, { method: 'POST' }),
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: ['competitions'] });
      setCompetitionId(id);
      toast.success('You joined!', { description: 'Your competition wallet is now active in the header.' });
    },
    onError: (e) =>
      toast.error('Could not join', { description: e instanceof ApiError ? e.message : 'Network error' }),
  });

  const live = comps?.find((c) => c.status === 'LIVE');
  const shown = selected === undefined ? (competitionId ?? live?.id ?? null) : selected;
  const shownComp = comps?.find((c) => c.id === shown);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-6xl space-y-3 p-3">
      <div className="flex items-start gap-3">
        <Trophy className="mt-1 size-6 text-warn" />
        <div>
          <h1 className="text-lg font-semibold">Competitions</h1>
          <p className="text-sm text-muted">
            Each competition gives everyone a fresh wallet with the same virtual cash, so it’s a fair race.
            Rankings are by return and refresh every few seconds.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="space-y-2">
          {isLoading && <Skeleton className="h-32" />}
          <button
            type="button"
            onClick={() => setSelected(null)}
            className={cn(
              'w-full rounded-lg border p-3 text-left hover:bg-panel-2/60',
              shown === null && 'border-accent bg-accent/5',
            )}
          >
            <p className="font-medium">Everyday practice leaderboard</p>
            <p className="text-xs text-muted">Everyone’s main wallet, all the time</p>
          </button>
          {comps?.map((c) => {
            const left = timeLeft(c);
            return (
              <Card
                key={c.id}
                className={cn(
                  'cursor-pointer p-3 transition-colors hover:bg-panel-2/60',
                  shown === c.id && 'border-accent bg-accent/5',
                )}
                role="button"
                tabIndex={0}
                aria-pressed={shown === c.id}
                onClick={() => setSelected(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(c.id);
                  }
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{c.name}</p>
                    {c.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{c.description}</p>
                    )}
                  </div>
                  <Badge variant={STATUS[c.status].variant}>{STATUS[c.status].label}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <CalendarClock className="size-3.5" />
                    {fmtDate(c.startsAt)} – {fmtDate(c.endsAt)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users className="size-3.5" />
                    {c.participants}
                  </span>
                  <span>Start with {inr(c.startingCash, { noDecimals: true })}</span>
                  {left && <span className="text-foreground">{left}</span>}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {c.joined ? (
                    <>
                      {c.myRank && <span className="num text-xs">Your rank: #{c.myRank}</span>}
                      {c.status === 'LIVE' && (
                        <Button
                          size="sm"
                          className="ml-auto"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCompetitionId(c.id);
                            navigate('/trade');
                          }}
                        >
                          Trade in this competition
                        </Button>
                      )}
                    </>
                  ) : (
                    c.status !== 'ENDED' && (
                      <Button
                        size="sm"
                        variant="buy"
                        className="ml-auto"
                        disabled={join.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          join.mutate(c.id);
                        }}
                      >
                        Join
                      </Button>
                    )
                  )}
                </div>
              </Card>
            );
          })}
          {comps && !comps.length && (
            <p className="text-sm text-muted">No competitions yet. An admin can create one.</p>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{shownComp ? shownComp.name : 'Everyday practice'} · leaderboard</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <LeaderboardTable competitionId={shown} />
          </CardContent>
        </Card>
      </div>
    </motion.div>
  );
}
