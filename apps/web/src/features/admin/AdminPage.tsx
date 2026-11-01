import { useState } from 'react';
import { Navigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Activity, CheckCircle2, Pause, Play, ShieldCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { baseAsset, inr, price, qty } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';

interface Overview {
  now: number;
  engine: { symbol: string; seq: number; lagMs: number; resting: number; halted: boolean; stale: boolean }[];
  feeds: {
    symbols: Record<
      string,
      { source: string | null; pricePaise: number | null; ageMs: number | null; stale: boolean }
    >;
    providers: Record<string, string>;
    usdInr: number | null;
    stale: boolean;
  };
  api: { nodes: number; connections: number };
  pipeline: {
    symbol: string;
    status: 'ACTIVE' | 'HALTED' | 'DISABLED';
    engineSeq: number | null;
    settledSeq: number | null;
    lastTradeSeq: number | null;
    coachedSeq: number;
  }[];
  counts: {
    users: number;
    open_orders: number;
    trades_24h: number;
    trips_24h: number;
    leaderboard_refreshed_at: string | null;
  };
}
interface BotRow {
  id: number;
  symbol: string;
  kind: 'MAKER' | 'FLOW';
  enabled: boolean;
  spread_bps: number;
  size_units: number;
  qty_scale: number;
  inventory_units: number;
  cash_paise: number;
}
interface InvariantReport {
  ok: boolean;
  results: { name: string; explain: string; ok: boolean; violations: unknown[] }[];
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Network error');

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span className={cn('inline-block size-2 rounded-full', ok ? 'bg-buy' : warn ? 'bg-warn' : 'bg-sell')} />
  );
}

function HealthCards({ o }: { o: Overview }) {
  const providers = Object.entries(o.feeds.providers);
  const engineOk = o.engine.length > 0 && o.engine.every((e) => !e.stale);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Card className="p-3">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
          <Dot ok={engineOk} /> Matching engine
        </p>
        <p className="num mt-1 text-xl font-semibold">{o.engine.length} books</p>
        <p className="num text-xs text-muted">
          max command lag {Math.max(0, ...o.engine.map((e) => e.lagMs ?? 0))} ms
        </p>
      </Card>
      <Card className="p-3">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
          <Dot ok={!o.feeds.stale} /> Market data
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {providers.map(([name, st]) => (
            <Badge key={name} variant={st === 'live' ? 'buy' : st === 'stopped' ? 'default' : 'warn'}>
              {name}: {st}
            </Badge>
          ))}
        </div>
        {o.feeds.usdInr && <p className="num mt-1 text-xs text-muted">USD→INR {o.feeds.usdInr} (config)</p>}
      </Card>
      <Card className="p-3">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
          <Dot ok={o.api.nodes > 0} /> API / websockets
        </p>
        <p className="num mt-1 text-xl font-semibold">{o.api.connections}</p>
        <p className="text-xs text-muted">
          live connections · {o.api.nodes} node{o.api.nodes === 1 ? '' : 's'}
        </p>
      </Card>
      <Card className="p-3">
        <p className="text-[11px] uppercase tracking-wide text-muted">Activity (24h)</p>
        <p className="num mt-1 text-xl font-semibold">{o.counts.trades_24h.toLocaleString('en-IN')} trades</p>
        <p className="num text-xs text-muted">
          {o.counts.users} users · {o.counts.open_orders} open orders · {o.counts.trips_24h} coached trips
        </p>
      </Card>
    </div>
  );
}

function PipelineTable({ o }: { o: Overview }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: ({ symbol, action }: { symbol: string; action: 'halt' | 'resume' }) =>
      api(`/admin/instruments/${symbol}/${action}`, { method: 'POST' }),
    onSuccess: (_r, v) => {
      toast.success(`${v.action === 'halt' ? 'Halt' : 'Resume'} sent to the ${v.symbol} engine`);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['admin'] }), 800);
    },
    onError: (e) => toast.error('Failed', { description: errMsg(e) }),
  });
  const engineBy = new Map(o.engine.map((e) => [e.symbol, e]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Order pipeline per instrument</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <p className="px-3 pb-2 text-xs text-muted">
          Every order flows engine → settlement (balances, exactly once) → Trade Coach. Lag = how far each
          stage is behind the one before it.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
            <tr className="border-y">
              <th className="px-3 py-2">Instrument</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Engine seq</th>
              <th className="px-3 py-2 text-right">Settlement lag</th>
              <th className="px-3 py-2 text-right">Coach lag</th>
              <th className="hidden px-3 py-2 text-right md:table-cell">Price source</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {o.pipeline
              .filter((p) => p.status !== 'DISABLED')
              .map((p) => {
                const e = engineBy.get(p.symbol);
                // the engine seq comes from a heartbeat up to 1 s old, so settlement can briefly look "ahead": clamp at 0
                const settleLag =
                  p.engineSeq !== null && p.settledSeq !== null
                    ? Math.max(0, p.engineSeq - p.settledSeq)
                    : null;
                const coachLag = p.lastTradeSeq !== null ? Math.max(0, p.lastTradeSeq - p.coachedSeq) : 0;
                const feed = o.feeds.symbols[p.symbol];
                const halted = p.status === 'HALTED';
                return (
                  <tr key={p.symbol} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">{p.symbol}</td>
                    <td className="px-3 py-2">
                      <Badge variant={halted ? 'sell' : e?.stale ? 'warn' : 'buy'}>
                        {halted ? 'Halted' : e?.stale ? 'No heartbeat' : 'Trading'}
                      </Badge>
                    </td>
                    <td className="num px-3 py-2 text-right">
                      {p.engineSeq?.toLocaleString('en-IN') ?? '—'}
                    </td>
                    <td
                      className={cn('num px-3 py-2 text-right', settleLag && settleLag > 50 && 'text-warn')}
                    >
                      {settleLag ?? '—'}
                    </td>
                    <td className={cn('num px-3 py-2 text-right', coachLag > 200 && 'text-warn')}>
                      {coachLag}
                    </td>
                    <td className="hidden px-3 py-2 text-right text-xs md:table-cell">
                      {feed ? (
                        <span className={cn(feed.stale && 'text-warn')}>
                          {feed.source ?? '—'} · {price(feed.pricePaise)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant={halted ? 'buy' : 'outline'}
                        disabled={act.isPending}
                        onClick={() => {
                          if (
                            !halted &&
                            !window.confirm(`Halt all trading in ${p.symbol}? New orders will be rejected.`)
                          )
                            return;
                          act.mutate({ symbol: p.symbol, action: halted ? 'resume' : 'halt' });
                        }}
                      >
                        {halted ? <Play /> : <Pause />}
                        {halted ? 'Resume' : 'Halt'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function BotsCard() {
  const qc = useQueryClient();
  const bots = useQuery({ queryKey: ['admin', 'bots'], queryFn: () => api<BotRow[]>('/admin/bots') });
  const save = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { enabled?: boolean; spreadBps?: number } }) =>
      api(`/admin/bots/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      toast.success('Saved', { description: 'Bot settings apply when the worker restarts.' });
      void qc.invalidateQueries({ queryKey: ['admin', 'bots'] });
    },
    onError: (e) => toast.error('Failed', { description: errMsg(e) }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bots</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <p className="px-3 pb-2 text-xs text-muted">
          Market makers quote both sides around the real price; flow bots trade small amounts so the book
          moves. Changes apply after the worker restarts.
        </p>
        {bots.isLoading ? (
          <Skeleton className="m-3 h-24" />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
              <tr className="border-y">
                <th className="px-3 py-2">Bot</th>
                <th className="px-3 py-2 text-right">Spread (bps)</th>
                <th className="hidden px-3 py-2 text-right sm:table-cell">Inventory</th>
                <th className="hidden px-3 py-2 text-right md:table-cell">Cash</th>
                <th className="px-3 py-2 text-right">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {bots.data?.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    {b.symbol}{' '}
                    <span className="text-xs text-muted">{b.kind === 'MAKER' ? 'market maker' : 'flow'}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {b.kind === 'MAKER' ? (
                      <Input
                        type="number"
                        min={1}
                        max={1000}
                        defaultValue={b.spread_bps}
                        aria-label={`Spread for ${b.symbol} market maker`}
                        className="ml-auto h-7 w-20 text-right"
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v !== b.spread_bps && v >= 1 && v <= 1000)
                            save.mutate({ id: b.id, body: { spreadBps: v } });
                        }}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num hidden px-3 py-2 text-right sm:table-cell">
                    {qty(b.inventory_units, b.qty_scale)} {baseAsset(b.symbol)}
                  </td>
                  <td className="num hidden px-3 py-2 text-right md:table-cell">
                    {inr(b.cash_paise, { compact: true })}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="checkbox"
                      checked={b.enabled}
                      aria-label={`Enable ${b.symbol} ${b.kind} bot`}
                      onChange={(e) => save.mutate({ id: b.id, body: { enabled: e.target.checked } })}
                      className="size-4 accent-[var(--accent)]"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function toLocalInput(d: Date) {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

function CreateCompetition() {
  const qc = useQueryClient();
  const [form, setForm] = useState(() => ({
    name: '',
    description: '',
    startsAt: toLocalInput(new Date()),
    endsAt: toLocalInput(new Date(Date.now() + 7 * 86_400_000)),
    cash: '100000',
  }));
  const create = useMutation({
    mutationFn: () =>
      api<{ id: number }>('/competitions', {
        method: 'POST',
        body: {
          name: form.name,
          description: form.description,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: new Date(form.endsAt).toISOString(),
          startingCashRupees: Number(form.cash),
        },
      }),
    onSuccess: () => {
      toast.success('Competition created');
      setForm((f) => ({ ...f, name: '', description: '' }));
      void qc.invalidateQueries({ queryKey: ['competitions'] });
    },
    onError: (e) => toast.error('Could not create', { description: errMsg(e) }),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>New competition</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="sm:col-span-2">
            <Label htmlFor="c-name">Name</Label>
            <Input
              id="c-name"
              required
              minLength={3}
              maxLength={80}
              value={form.name}
              onChange={set('name')}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="c-desc">Description</Label>
            <Input id="c-desc" maxLength={500} value={form.description} onChange={set('description')} />
          </div>
          <div>
            <Label htmlFor="c-start">Starts</Label>
            <Input
              id="c-start"
              type="datetime-local"
              required
              value={form.startsAt}
              onChange={set('startsAt')}
            />
          </div>
          <div>
            <Label htmlFor="c-end">Ends</Label>
            <Input id="c-end" type="datetime-local" required value={form.endsAt} onChange={set('endsAt')} />
          </div>
          <div>
            <Label htmlFor="c-cash">Starting cash (₹)</Label>
            <Input
              id="c-cash"
              type="number"
              min={1000}
              max={10000000}
              required
              value={form.cash}
              onChange={set('cash')}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" className="w-full" disabled={create.isPending}>
              Create
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function LedgerCheck() {
  const run = useMutation({
    mutationFn: () => api<InvariantReport>('/admin/invariants', { method: 'POST' }),
  });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Ledger check</CardTitle>
        <Button size="sm" variant="outline" onClick={() => run.mutate()} disabled={run.isPending}>
          <ShieldCheck />
          {run.isPending ? 'Checking…' : 'Run checks'}
        </Button>
      </CardHeader>
      <CardContent className="text-sm">
        {!run.data && !run.isPending && (
          <p className="text-muted">
            Verifies in SQL that no money or coins were created or lost: balances never negative, cash and
            units conserved, holds match open orders, every fill settled exactly once.
          </p>
        )}
        {run.data && (
          <>
            <p className={cn('mb-2 font-medium', run.data.ok ? 'text-buy' : 'text-sell')}>
              {run.data.ok ? 'All invariants hold.' : 'Violations found!'}
            </p>
            <ul className="space-y-1">
              {run.data.results.map((r) => (
                <li key={r.name} className="flex items-start gap-1.5">
                  {r.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-buy" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-sell" />
                  )}
                  <span>
                    <span className="font-mono text-xs">{r.name}</span>
                    <span className="block text-xs text-muted">{r.explain}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminPage() {
  const role = useAuth((s) => s.user?.role);
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api<Overview>('/admin/overview'),
    refetchInterval: 3000,
    enabled: role === 'ADMIN',
  });
  if (role && role !== 'ADMIN') return <Navigate to="/trade" replace />;
  const o = overview.data;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6"
    >
      <PageHeader
        icon={Activity}
        title="System health"
        subtitle={
          o?.counts.leaderboard_refreshed_at
            ? `Live · leaderboards refreshed ${new Date(o.counts.leaderboard_refreshed_at).toLocaleTimeString('en-IN')}`
            : 'Live view of every service'
        }
      />
      {!o ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <HealthCards o={o} />
          <PipelineTable o={o} />
        </>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <BotsCard />
        <div className="space-y-3">
          <CreateCompetition />
          <LedgerCheck />
        </div>
      </div>
    </motion.div>
  );
}
