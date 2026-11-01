import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Card, Input, Kbd, Label, Segmented, Slider, Tip } from '@/components/ui/primitives';
import { useAccountContext, usePortfolio } from '@/hooks/data';
import { api, ApiError } from '@/lib/api';
import { baseAsset, inr, parsePrice, parseQty, qty as fmtQty, qtyDecimals, rupeesString } from '@/lib/format';
import type { Instrument, Order } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useMarket } from '@/stores/market';
import { useUi } from '@/stores/ui';

type Kind = 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'STOP_LIMIT';
type Tif = 'GTC' | 'IOC' | 'FOK';

const KIND_HELP: Record<Kind, string> = {
  LIMIT: 'Limit: trade only at your price or better. If nobody matches it now, it waits in the order book.',
  MARKET:
    'Market: trade immediately at the best available prices. Fast, but you accept whatever the book offers (within a 5% protection band).',
  STOP_MARKET:
    'Stop: does nothing until the price reaches your stop price, then becomes a market order. Usually used as a stop-loss to limit losses.',
  STOP_LIMIT:
    'Stop-limit: when the stop price is reached, places a limit order at your limit price. More control than a stop, but it may not fill.',
};
const TIF_HELP =
  'GTC: stays until filled or cancelled. IOC: fill what you can now, cancel the rest. FOK: fill everything now or nothing.';

export function OrderPanel({ inst }: { inst: Instrument }) {
  const ui = useUi();
  const qc = useQueryClient();
  const pf = usePortfolio().data;
  const ref = useMarket((s) => s.ticks[inst.symbol]?.price) ?? inst.refPrice ?? 0;
  const book = useMarket((s) => s.books[inst.symbol]);

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [kind, setKind] = useState<Kind>('LIMIT');
  const [tif, setTif] = useState<Tif>('GTC');
  const [priceStr, setPriceStr] = useState('');
  const [stopStr, setStopStr] = useState('');
  const [qtyStr, setQtyStr] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const [planStopStr, setPlanStopStr] = useState('');
  const [planTargetStr, setPlanTargetStr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const qtyRef = useRef<HTMLInputElement>(null);

  // keyboard B / S from the trade page
  useEffect(() => {
    if (!ui.orderFocusTick) return;
    setSide(ui.side);
    qtyRef.current?.focus();
  }, [ui.orderFocusTick, ui.side]);
  // clicked a price in the order book
  useEffect(() => {
    if (!ui.prefill) return;
    setPriceStr(rupeesString(ui.prefill.price));
    if (kind === 'MARKET' || kind === 'STOP_MARKET') setKind('LIMIT');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.prefill?.tick]);
  // start the limit price at the reference price for convenience
  useEffect(() => {
    if (!priceStr && ref) setPriceStr(rupeesString(ref));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref > 0, inst.symbol]);
  useEffect(() => {
    if ((kind === 'MARKET' || kind === 'STOP_MARKET') && tif === 'GTC') setTif('IOC');
  }, [kind, tif]);

  const isLimit = kind === 'LIMIT' || kind === 'STOP_LIMIT';
  const isStop = kind === 'STOP_MARKET' || kind === 'STOP_LIMIT';
  const limitPrice = isLimit ? parsePrice(priceStr, inst.tickSizePaise) : null;
  const stopPrice = isStop ? parsePrice(stopStr, inst.tickSizePaise) : null;
  const units = parseQty(qtyStr, inst.qtyScale);
  const band = 1 + inst.priceBandBps / 10_000;
  // price used to reserve cash for a buy: the limit, or the protection price for market-type orders
  const holdPx = isLimit
    ? limitPrice
    : side === 'BUY'
      ? Math.floor(((isStop ? stopPrice : ref) ?? 0) * band)
      : null;
  const estPx = isLimit
    ? limitPrice
    : kind === 'MARKET'
      ? ((side === 'BUY' ? book?.asks[0]?.price : book?.bids[0]?.price) ?? ref)
      : stopPrice;
  const holding = pf?.holdings.find((h) => h.symbol === inst.symbol);
  const availUnits = holding ? holding.qty - holding.heldQty : 0;
  const availCash = pf?.cashAvailable ?? 0;
  const est = units && estPx ? Math.round((estPx * units) / inst.qtyScale) : null;
  const reserve = side === 'BUY' && units && holdPx ? Math.round((holdPx * units) / inst.qtyScale) : null;

  const maxUnits = useMemo(() => {
    if (side === 'SELL') return availUnits;
    if (!holdPx) return 0;
    return Math.floor((availCash * inst.qtyScale) / holdPx / inst.lotSizeUnits) * inst.lotSizeUnits;
  }, [side, availUnits, availCash, holdPx, inst]);
  const pctOfMax = units && maxUnits ? Math.min(100, (units / maxUnits) * 100) : 0;
  const setPct = (p: number) => {
    const u = Math.floor((maxUnits * p) / 100 / inst.lotSizeUnits) * inst.lotSizeUnits;
    setQtyStr(u > 0 ? (u / inst.qtyScale).toFixed(qtyDecimals(inst.qtyScale)) : '');
  };

  // exit plan & risk
  const planStop = parsePrice(planStopStr, inst.tickSizePaise);
  const planTarget = parsePrice(planTargetStr, inst.tickSizePaise);
  const entry = estPx ?? ref;
  const riskPaise =
    units && planStop && entry ? Math.round((Math.abs(entry - planStop) * units) / inst.qtyScale) : null;
  const riskPct = riskPaise && pf ? (riskPaise / pf.equity) * 100 : null;
  const rr =
    planStop && planTarget && entry
      ? Math.abs(planTarget - entry) / Math.max(1, Math.abs(entry - planStop))
      : null;

  let problem: string | null = null;
  if (!units)
    problem = `Enter a quantity (multiples of ${fmtQty(inst.lotSizeUnits, inst.qtyScale)} ${baseAsset(inst.symbol)})`;
  else if (units % inst.lotSizeUnits) problem = 'Quantity must be a multiple of the lot size';
  else if (isLimit && !limitPrice) problem = 'Enter a limit price';
  else if (isStop && !stopPrice) problem = 'Enter a stop price';
  else if (side === 'BUY' && reserve != null && reserve > availCash)
    problem = `Not enough cash: needs ${inr(reserve)}, you have ${inr(availCash)}`;
  else if (side === 'SELL' && units > availUnits)
    problem = `You only have ${fmtQty(availUnits, inst.qtyScale)} ${baseAsset(inst.symbol)} available (no short selling)`;
  else if (inst.status !== 'ACTIVE') problem = 'Trading is halted for this instrument';

  const competitionId = useAccountContext();
  const place = useMutation({
    mutationFn: () =>
      api<Order>('/orders', {
        method: 'POST',
        body: {
          symbol: inst.symbol,
          side,
          type: kind,
          tif,
          qty: units,
          price: isLimit ? limitPrice : undefined,
          stopPrice: isStop ? stopPrice : undefined,
          planStopPrice: planOpen && planStop ? planStop : undefined,
          planTargetPrice: planOpen && planTarget ? planTarget : undefined,
          competitionId: competitionId ?? undefined,
        },
      }),
    onSuccess: (o) => {
      toast.success(`${o.side === 'BUY' ? 'Buy' : 'Sell'} order sent`, {
        description: `${fmtQty(o.qty, inst.qtyScale)} ${baseAsset(inst.symbol)} · ${kind.replace('_', ' ').toLowerCase()}`,
      });
      setConfirm(false);
      setQtyStr('');
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
    onError: (e) => {
      setConfirm(false);
      toast.error('Order rejected', { description: e instanceof ApiError ? e.message : 'Network error' });
    },
  });

  const tone = side === 'BUY' ? 'buy' : 'sell';
  return (
    <Card className="flex h-full min-h-0 flex-col">
      <form
        className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) setConfirm(true);
        }}
        aria-label="Order entry"
      >
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-panel-2 p-1">
          {(['BUY', 'SELL'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              aria-pressed={side === s}
              className={cn(
                'cursor-pointer rounded-md py-1.5 text-sm font-semibold transition-colors',
                side === s
                  ? s === 'BUY'
                    ? 'bg-buy text-white dark:text-[#06140e]'
                    : 'bg-sell text-white'
                  : 'text-muted hover:text-foreground',
              )}
            >
              {s === 'BUY' ? 'Buy' : 'Sell'} <Kbd>{s === 'BUY' ? 'B' : 'S'}</Kbd>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Segmented<Kind>
            value={kind}
            onChange={setKind}
            size="xs"
            options={[
              { value: 'LIMIT', label: 'Limit' },
              { value: 'MARKET', label: 'Market' },
              { value: 'STOP_MARKET', label: 'Stop' },
              { value: 'STOP_LIMIT', label: 'Stop-limit' },
            ]}
          />
          <Tip content={KIND_HELP[kind]}>
            <Info className="size-4 text-muted" aria-label={KIND_HELP[kind]} />
          </Tip>
        </div>

        {isStop && (
          <PriceField
            id="stop"
            label="Stop price (trigger)"
            value={stopStr}
            onChange={setStopStr}
            hint={`Reference ₹${rupeesString(ref)}`}
          />
        )}
        {isLimit && (
          <PriceField
            id="price"
            label="Limit price"
            value={priceStr}
            onChange={setPriceStr}
            onUseRef={() => setPriceStr(rupeesString(ref))}
          />
        )}
        {kind === 'MARKET' && (
          <p className="rounded-md bg-panel-2 px-2.5 py-2 text-xs text-muted">
            Executes now at the best {side === 'BUY' ? 'ask' : 'bid'} (≈{' '}
            <span className="num text-foreground">{inr(estPx ?? null)}</span>), never worse than{' '}
            <span className="num text-foreground">
              {inr(Math.round(ref * (side === 'BUY' ? band : 2 - band)))}
            </span>
            .
          </p>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="qty">Quantity ({baseAsset(inst.symbol)})</Label>
            <span className="text-[11px] text-muted">
              Max <span className="num">{fmtQty(maxUnits, inst.qtyScale)}</span>
            </span>
          </div>
          <Input
            ref={qtyRef}
            id="qty"
            inputMode="decimal"
            placeholder={fmtQty(inst.lotSizeUnits, inst.qtyScale)}
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            className="num"
          />
          <Slider
            tone={tone}
            value={[pctOfMax]}
            max={100}
            step={1}
            onValueChange={([v]) => setPct(v ?? 0)}
            className="pt-1"
          />
          <div className="grid grid-cols-4 gap-1">
            {[25, 50, 75, 100].map((p) => (
              <Button key={p} type="button" variant="subtle" size="sm" onClick={() => setPct(p)}>
                {p}%
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <Tip content={TIF_HELP}>
            <Label>Time in force</Label>
          </Tip>
          <Segmented<Tif>
            value={tif}
            onChange={setTif}
            size="xs"
            options={(['GTC', 'IOC', 'FOK'] as const)
              .filter((t) => !(t === 'GTC' && (kind === 'MARKET' || kind === 'STOP_MARKET')))
              .map((t) => ({ value: t, label: t }))}
          />
        </div>

        <div>
          <button
            type="button"
            onClick={() => setPlanOpen((o) => !o)}
            className="flex w-full cursor-pointer items-center justify-between text-xs font-medium text-muted hover:text-foreground"
            aria-expanded={planOpen}
          >
            Plan your exit (the Coach checks this)
            <ChevronDown className={cn('size-4 transition-transform', planOpen && 'rotate-180')} />
          </button>
          <AnimatePresence initial={false}>
            {planOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-2 gap-2 pt-2">
                  <PriceField
                    id="plan-stop"
                    label="Stop-loss ₹"
                    value={planStopStr}
                    onChange={setPlanStopStr}
                    compact
                  />
                  <PriceField
                    id="plan-target"
                    label="Target ₹"
                    value={planTargetStr}
                    onChange={setPlanTargetStr}
                    compact
                  />
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px]">
                  <Metric label="At risk" value={riskPaise != null ? inr(riskPaise) : '—'} />
                  <Metric
                    label="% of equity"
                    value={riskPct != null ? `${riskPct.toFixed(1)}%` : '—'}
                    warn={riskPct != null && riskPct > 2}
                  />
                  <Metric
                    label="Reward : risk"
                    value={rr != null ? `${rr.toFixed(1)} : 1` : '—'}
                    warn={rr != null && rr < 1.5}
                  />
                </dl>
                <p className="mt-1 text-[11px] text-muted">
                  Rule of thumb: risk ≤ 1–2% of equity per trade, aim for ≥ 2 : 1.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <dl className="space-y-1 border-t pt-2 text-xs">
          <Line label={side === 'BUY' ? 'Estimated cost' : 'Estimated proceeds'} value={inr(est)} />
          {side === 'BUY' && reserve != null && reserve !== est && (
            <Line label="Reserved until filled" value={inr(reserve)} muted />
          )}
          <Line
            label="Available"
            value={
              side === 'BUY'
                ? inr(availCash)
                : `${fmtQty(availUnits, inst.qtyScale)} ${baseAsset(inst.symbol)}`
            }
            muted
          />
        </dl>

        <div className="mt-auto space-y-2">
          {problem && units != null && <p className="text-xs text-sell">{problem}</p>}
          <Button
            type="submit"
            variant={tone}
            size="lg"
            className="w-full"
            disabled={!!problem || place.isPending}
          >
            {side === 'BUY' ? 'Buy' : 'Sell'} {baseAsset(inst.symbol)}
          </Button>
        </div>
      </form>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogTitle>Confirm {side === 'BUY' ? 'buy' : 'sell'} order</DialogTitle>
          <DialogDescription>Virtual money only. Review before sending.</DialogDescription>
          <dl className="mt-4 space-y-1.5 text-sm">
            <Line label="Instrument" value={inst.symbol} />
            <Line label="Type" value={`${kind.replace('_', ' ').toLowerCase()} · ${tif}`} />
            <Line label="Quantity" value={`${fmtQty(units ?? 0, inst.qtyScale)} ${baseAsset(inst.symbol)}`} />
            {isStop && <Line label="Stop price" value={inr(stopPrice)} />}
            {isLimit && <Line label="Limit price" value={inr(limitPrice)} />}
            <Line label={side === 'BUY' ? 'Estimated cost' : 'Estimated proceeds'} value={inr(est)} />
            {planOpen && planStop && <Line label="Planned stop-loss" value={inr(planStop)} />}
            {planOpen && planTarget && <Line label="Planned target" value={inr(planTarget)} />}
          </dl>
          <p className="mt-3 rounded-md bg-panel-2 p-2.5 text-xs text-muted">
            {plainEnglish(side, kind, inst, units, limitPrice, stopPrice)}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel <Kbd>Esc</Kbd>
            </Button>
            <Button variant={tone} onClick={() => place.mutate()} disabled={place.isPending} autoFocus>
              {place.isPending ? 'Sending…' : 'Confirm'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function plainEnglish(
  side: 'BUY' | 'SELL',
  kind: Kind,
  inst: Instrument,
  units: number | null,
  limit: number | null,
  stop: number | null,
) {
  const q = `${fmtQty(units ?? 0, inst.qtyScale)} ${baseAsset(inst.symbol)}`;
  const verb = side === 'BUY' ? 'buy' : 'sell';
  switch (kind) {
    case 'LIMIT':
      return `You will ${verb} ${q} at ${inr(limit)} or ${side === 'BUY' ? 'lower' : 'higher'}. If no one matches it right away, your order waits in the order book.`;
    case 'MARKET':
      return `You will ${verb} ${q} right now at the best prices in the book. The final price can differ slightly from the estimate (slippage).`;
    case 'STOP_MARKET':
      return `Nothing happens until the price ${side === 'BUY' ? 'rises' : 'falls'} to ${inr(stop)}. Then a market order will ${verb} ${q}.`;
    case 'STOP_LIMIT':
      return `When the price reaches ${inr(stop)}, a limit order to ${verb} ${q} at ${inr(limit)} is placed. It may not fill if the price moves past your limit.`;
  }
}

function PriceField({
  id,
  label,
  value,
  onChange,
  onUseRef,
  hint,
  compact,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onUseRef?: () => void;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {onUseRef && (
          <button
            type="button"
            onClick={onUseRef}
            className="cursor-pointer text-[11px] text-accent hover:underline"
          >
            Use market
          </button>
        )}
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </div>
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted">
          ₹
        </span>
        <Input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn('num pl-6', compact && 'h-8')}
        />
      </div>
    </div>
  );
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={cn('num', muted && 'text-muted')}>{value}</dd>
    </div>
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md bg-panel-2 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className={cn('num font-medium', warn && 'text-warn')}>{value}</dd>
    </div>
  );
}
