import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  ChevronDown,
  Flag,
  GraduationCap,
  Lightbulb,
  Scale,
  Shield,
  Star,
  Target,
  Trophy,
} from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { COACH_FLAGS, type CoachFlag } from '@tradecore/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton, Tip } from '@/components/ui/primitives';
import { useAccountContext, withAccount } from '@/hooks/data';
import { api } from '@/lib/api';
import { baseAsset, pct, price, qty, signedInr } from '@/lib/format';
import type { CoachSummary, CoachTrip } from '@/lib/types';
import { cn } from '@/lib/utils';

const GRADE_STYLE: Record<CoachTrip['grade'], string> = {
  A: 'bg-buy text-white dark:text-[#06140e]',
  B: 'bg-buy/70 text-white dark:text-[#06140e]',
  C: 'bg-warn text-[#1a1203]',
  D: 'bg-sell/70 text-white',
  F: 'bg-sell text-white',
};
const BADGE_ICONS: Record<string, typeof Award> = {
  flag: Flag,
  shield: Shield,
  scale: Scale,
  star: Star,
  target: Target,
  trophy: Trophy,
};

const flagInfo = (f: string) => COACH_FLAGS[f as CoachFlag];

function useCoachSummary() {
  const cid = useAccountContext();
  return useQuery({
    queryKey: ['coach', 'summary', cid],
    queryFn: () => api<CoachSummary>(withAccount('/coach/summary', cid)),
    refetchInterval: 15_000,
  });
}

function useCoachTrips() {
  const cid = useAccountContext();
  return useInfiniteQuery({
    queryKey: ['coach', 'trips', cid],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<CoachTrip[]>(withAccount(`/coach/trips?limit=20${pageParam ? `&before=${pageParam}` : ''}`, cid)),
    getNextPageParam: (last) => (last.length === 20 ? last[last.length - 1]!.id : undefined),
    refetchInterval: 15_000,
  });
}

/** Animated ring showing the Skill Score out of 100. */
function ScoreRing({ score, size = 132 }: { score: number | null; size?: number }) {
  const r = (size - 14) / 2;
  const c = 2 * Math.PI * r;
  const v = score ?? 0;
  const color = v >= 80 ? 'var(--buy)' : v >= 55 ? 'var(--warn)' : 'var(--sell)';
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={10} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - v / 100) }}
          transition={{ duration: 1, ease: 'easeOut' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="num text-3xl font-bold" aria-label={`Skill score ${score ?? 'not yet available'}`}>
            {score ?? '—'}
          </p>
          <p className="text-[11px] text-muted">/ 100</p>
        </div>
      </div>
    </div>
  );
}

function FlagChip({ flag }: { flag: string }) {
  const f = flagInfo(flag);
  if (!f) return null;
  return (
    <Tip content={f.explain}>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
          f.good ? 'bg-buy-soft text-buy' : 'bg-warn/15 text-warn',
        )}
      >
        {f.good ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}
        {f.label}
      </span>
    </Tip>
  );
}

function holdLabel(min: number) {
  if (min < 1) return '< 1 min';
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 60 * 24) return `${(min / 60).toFixed(1)} h`;
  return `${(min / 1440).toFixed(1)} days`;
}

function TripCard({ t }: { t: CoachTrip }) {
  const [open, setOpen] = useState(false);
  const win = t.pnl > 0;
  return (
    <motion.li layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="overflow-hidden">
        <button
          type="button"
          className="flex w-full items-start gap-3 p-3 text-left hover:bg-panel-2/50"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span
            className={cn(
              'grid size-11 shrink-0 place-items-center rounded-lg text-xl font-bold',
              GRADE_STYLE[t.grade],
            )}
            aria-label={`Grade ${t.grade}`}
          >
            {t.grade}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold">{baseAsset(t.symbol)}</span>
              <span className="num text-xs text-muted">
                {qty(t.qty, t.qty_scale)} · {price(t.entry_price)} → {price(t.exit_price)}
              </span>
              {t.source === 'seed' && <Badge>Demo history</Badge>}
              <span className={cn('num ml-auto text-sm font-semibold', win ? 'text-buy' : 'text-sell')}>
                {signedInr(t.pnl)} <span className="text-xs font-normal">({pct(t.details.returnPct)})</span>
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {t.flags.map((f) => (
                <FlagChip key={f} flag={f} />
              ))}
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-sm">
              <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent" />
              <span>{t.tip}</span>
            </p>
          </div>
          <ChevronDown
            className={cn('mt-1 size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')}
          />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              className="overflow-hidden border-t bg-panel-2/40"
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-3 text-xs sm:grid-cols-4">
                <Detail label="Process score" value={`${t.score} / 100`} />
                <Detail label="Position size" value={`${t.details.sizePct.toFixed(1)}% of your money`} />
                <Detail
                  label="At risk to your stop"
                  value={
                    t.details.riskPct == null
                      ? 'no planned stop'
                      : `${t.details.riskPct.toFixed(2)}% of your money`
                  }
                />
                <Detail label="Held for" value={holdLabel(t.details.holdMinutes)} />
                <Detail
                  label="Move before entry"
                  value={t.details.moveBeforeEntryPct === null ? '—' : pct(t.details.moveBeforeEntryPct)}
                />
                <Detail label="Planned stop" value={t.plan_stop ? price(t.plan_stop) : 'none'} />
                <Detail label="Planned target" value={t.plan_target ? price(t.plan_target) : 'none'} />
                <Detail
                  label="Planned risk : reward"
                  value={t.details.plannedRR === null ? '—' : `1 : ${t.details.plannedRR}`}
                />
                <Detail label="Closed" value={new Date(t.closed_at).toLocaleString('en-IN')} />
              </dl>
              <ul className="space-y-1 px-3 pb-3 text-xs text-muted">
                {t.flags.map((f) => (
                  <li key={f}>
                    <span className={flagInfo(f)?.good ? 'text-buy' : 'text-warn'}>
                      {flagInfo(f)?.label}:
                    </span>{' '}
                    {flagInfo(f)?.explain}
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </motion.li>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="num mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

export default function CoachPage() {
  const summary = useCoachSummary();
  const trips = useCoachTrips();
  const s = summary.data;

  if (summary.isLoading || !s)
    return (
      <div className="mx-auto grid max-w-6xl gap-3 p-3 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    );

  const prev = s.weeks.length >= 2 ? s.weeks[s.weeks.length - 2]! : null;
  const cur = s.current;
  const trend = cur && prev ? cur.skill_score - prev.skill_score : null;
  const list = trips.data?.pages.flat() ?? [];
  const gradeTotal = Object.values(s.totals.grades).reduce((a, b) => a + b, 0);
  const goodFlags = s.flags.filter((f) => flagInfo(f.flag)?.good);
  const badFlags = s.flags.filter((f) => flagInfo(f.flag) && !flagInfo(f.flag)!.good);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-6xl space-y-3 p-3">
      <div className="flex items-start gap-3">
        <GraduationCap className="mt-1 size-6 text-accent" />
        <div>
          <h1 className="text-lg font-semibold">Trade Coach</h1>
          <p className="text-sm text-muted">
            The coach grades <strong className="text-foreground">how</strong> you traded — risk, plan and
            habits — not whether you made money. A disciplined loss can earn an A; a lucky win with no stop
            earns an F.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-4 sm:flex-row">
            <ScoreRing score={cur?.skill_score ?? null} />
            <div className="min-w-0 flex-1 space-y-2 text-center sm:text-left">
              <p className="text-[11px] uppercase tracking-wide text-muted">Skill Score this week</p>
              {trend !== null && (
                <p className={cn('num text-sm font-medium', trend >= 0 ? 'text-buy' : 'text-sell')}>
                  {trend >= 0 ? '▲' : '▼'} {Math.abs(trend)} from last week
                </p>
              )}
              {cur ? (
                <div className="rounded-lg border border-accent/30 bg-accent/10 p-2.5 text-left">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-accent">
                    <Target className="size-3.5" /> This week’s goal
                  </p>
                  <p className="mt-0.5 text-sm">{cur.goal}</p>
                </div>
              ) : (
                <p className="text-sm text-muted">Close a trade to get your first score.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Skill Score history</CardTitle>
          </CardHeader>
          <CardContent className="h-40">
            {s.weeks.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={s.weeks} margin={{ left: -24, right: 8, top: 4 }}>
                  <defs>
                    <linearGradient id="skill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="week_start"
                    tickFormatter={(d: string) =>
                      new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                    }
                    tick={{ fontSize: 11, fill: 'var(--muted)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 11, fill: 'var(--muted)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--panel)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(d) => `Week of ${new Date(String(d)).toLocaleDateString('en-IN')}`}
                    formatter={(v) => [`${v} / 100`, 'Skill Score']}
                  />
                  <Area
                    type="monotone"
                    dataKey="skill_score"
                    stroke="var(--accent)"
                    fill="url(#skill)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="grid h-full place-items-center text-sm text-muted">
                Your trend appears after two weeks.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Graded trades" value={String(s.totals.trips)} />
        <Stat
          label="Average process score"
          value={s.totals.avgScore === null ? '—' : `${s.totals.avgScore}`}
        />
        <Stat
          label="Win rate"
          value={s.totals.trips ? `${Math.round((s.totals.wins / s.totals.trips) * 100)}%` : '—'}
          tip="Share of trades that made money. Useful, but the coach cares more about process: good habits win over time."
        />
        <Stat
          label="This week’s drawdown"
          value={cur?.max_drawdown_paise ? signedInr(cur.max_drawdown_paise) : '—'}
          tip="The biggest drop from a high point in your equity this week."
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Grade mix</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {(['A', 'B', 'C', 'D', 'F'] as const).map((g) => {
              const n = s.totals.grades[g] ?? 0;
              return (
                <div key={g} className="flex items-center gap-2 text-sm">
                  <span
                    className={cn('grid size-6 place-items-center rounded text-xs font-bold', GRADE_STYLE[g])}
                  >
                    {g}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel-2">
                    <motion.div
                      className={cn('h-full', GRADE_STYLE[g])}
                      initial={{ width: 0 }}
                      animate={{ width: gradeTotal ? `${(n / gradeTotal) * 100}%` : 0 }}
                    />
                  </div>
                  <span className="num w-6 text-right text-xs text-muted">{n}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Habits · last 30 days</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!s.flags.length && <p className="text-muted">No habits found yet.</p>}
            {badFlags.length > 0 && (
              <ul className="space-y-1">
                {badFlags.map((f) => (
                  <li key={f.flag} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <AlertTriangle className="size-3.5 text-warn" />
                      {flagInfo(f.flag)!.label}
                    </span>
                    <span className="num text-xs text-muted">{f.n}×</span>
                  </li>
                ))}
              </ul>
            )}
            {goodFlags.length > 0 && (
              <ul className="space-y-1 border-t pt-2">
                {goodFlags.map((f) => (
                  <li key={f.flag} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <CheckCircle2 className="size-3.5 text-buy" />
                      {flagInfo(f.flag)!.label}
                    </span>
                    <span className="num text-xs text-muted">{f.n}×</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Badges</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-2">
            {s.badges.map((b) => {
              const Icon = BADGE_ICONS[b.icon] ?? Award;
              return (
                <Tip key={b.code} content={`${b.description}${b.earned ? '' : ' (locked)'}`}>
                  <div
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg border p-2 text-center',
                      b.earned ? 'border-accent/40 bg-accent/10' : 'opacity-40 grayscale',
                    )}
                  >
                    <Icon className={cn('size-5', b.earned ? 'text-accent' : 'text-muted')} />
                    <span className="text-[11px] leading-tight">{b.name}</span>
                  </div>
                </Tip>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="report-cards">
        <h2 id="report-cards" className="mb-2 text-sm font-semibold">
          Trade report cards
        </h2>
        {s.openPositions.length > 0 && (
          <p className="mb-2 text-xs text-muted">
            Still open (graded when you’re back to zero):{' '}
            {s.openPositions.map((p) => baseAsset(p.symbol)).join(', ')}
          </p>
        )}
        {trips.isLoading ? (
          <Skeleton className="h-28" />
        ) : list.length ? (
          <ul className="space-y-2">
            {list.map((t) => (
              <TripCard key={t.id} t={t} />
            ))}
          </ul>
        ) : (
          <Card className="p-6 text-center">
            <p className="font-medium">No graded trades yet</p>
            <p className="mt-1 text-sm text-muted">
              Buy something, then sell it all. The coach grades each finished trade within about 10 seconds.
            </p>
            <Button asChild className="mt-3">
              <Link to="/trade">Go to Trade</Link>
            </Button>
          </Card>
        )}
        {trips.hasNextPage && (
          <div className="mt-2 text-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void trips.fetchNextPage()}
              disabled={trips.isFetchingNextPage}
            >
              {trips.isFetchingNextPage ? 'Loading…' : 'Load older trades'}
            </Button>
          </div>
        )}
      </section>
    </motion.div>
  );
}

function Stat({ label, value, tip }: { label: string; value: string; tip?: string }) {
  const body = (
    <Card className="p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="num mt-1 text-xl font-semibold">{value}</p>
    </Card>
  );
  return tip ? <Tip content={tip}>{body}</Tip> : body;
}
