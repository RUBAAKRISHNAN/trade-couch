import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Card, CardHeader, Segmented, Skeleton } from '@/components/ui/primitives';
import { useCandles } from '@/hooks/data';
import type { Candle, Instrument } from '@/lib/types';
import { useMarket } from '@/stores/market';
import { useUi } from '@/stores/ui';

const TF_SECONDS = { '1m': 60, '5m': 300, '1h': 3600, '1d': 86400 } as const;
type Tf = keyof typeof TF_SECONDS;

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Candlestick chart (TradingView lightweight-charts). Each candle = OHLC for one time bucket:
 * Open (first trade), High, Low, Close (last trade). Green when close ≥ open.
 * Volume bars underneath; orange line = 20-candle moving average (computed in SQL with a window function).
 */
export function PriceChart({ inst }: { inst: Instrument }) {
  const [tf, setTf] = useState<Tf>('1m');
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    c: ISeriesApi<'Candlestick'>;
    v: ISeriesApi<'Histogram'>;
    ma: ISeriesApi<'Line'>;
  } | null>(null);
  const lastBar = useRef<Candle | null>(null);
  const theme = useUi((s) => s.theme);
  const { data, isLoading } = useCandles(inst.symbol, tf);
  const tape = useMarket((s) => s.tape[inst.symbol]);

  // create the chart once
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      localization: {
        priceFormatter: (p: number) => (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
      },
    });
    const candle = c.addSeries(CandlestickSeries, { borderVisible: false, priceLineVisible: true });
    const vol = c.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const ma = c.addSeries(LineSeries, {
      color: '#f5a524',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.current = c;
    series.current = { c: candle, v: vol, ma };
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // theme colours
  useEffect(() => {
    if (!chart.current || !series.current) return;
    const text = cssVar('--muted');
    const grid = cssVar('--border');
    chart.current.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: text,
        fontFamily: 'Inter, sans-serif',
        attributionLogo: false,
      },
      grid: { vertLines: { color: grid + '55' }, horzLines: { color: grid + '55' } },
    });
    series.current.c.applyOptions({
      upColor: cssVar('--buy'),
      downColor: cssVar('--sell'),
      wickUpColor: cssVar('--buy'),
      wickDownColor: cssVar('--sell'),
    });
  }, [theme]);

  // load history
  useEffect(() => {
    if (!data || !series.current) return;
    const up = cssVar('--buy');
    const down = cssVar('--sell');
    series.current.c.setData(
      data.map((d) => ({
        time: d.time as UTCTimestamp,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      })),
    );
    series.current.v.setData(
      data.map((d) => ({
        time: d.time as UTCTimestamp,
        value: Number(d.volume),
        color: (d.close >= d.open ? up : down) + '66',
      })),
    );
    series.current.ma.setData(
      data.filter((d) => d.ma20).map((d) => ({ time: d.time as UTCTimestamp, value: d.ma20 })),
    );
    lastBar.current = data.at(-1) ?? null;
  }, [data]);

  // live: fold new trades into the current candle between refetches
  useEffect(() => {
    const s = series.current;
    const t = tape?.[0];
    if (!s || !t) return;
    const step = TF_SECONDS[tf];
    const bucket = Math.floor(t.ts / 1000 / step) * step;
    const prev = lastBar.current;
    if (prev && bucket < prev.time) return;
    const bar: Candle =
      prev && prev.time === bucket
        ? { ...prev, high: Math.max(prev.high, t.price), low: Math.min(prev.low, t.price), close: t.price }
        : { time: bucket, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0, ma20: 0 };
    lastBar.current = bar;
    s.c.update({
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });
  }, [tape, tf]);

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader>
        <Segmented<Tf>
          value={tf}
          onChange={setTf}
          size="xs"
          options={(Object.keys(TF_SECONDS) as Tf[]).map((k) => ({
            value: k,
            label: k,
            title: `${k} candles`,
          }))}
        />
        <span className="flex items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-[#f5a524]" /> MA 20
          </span>
          <span>{inst.symbol}</span>
        </span>
      </CardHeader>
      <div className="relative min-h-0 flex-1">
        <div
          ref={el}
          className="absolute inset-0"
          aria-label={`${inst.symbol} candlestick chart`}
          role="img"
        />
        {isLoading && <Skeleton className="absolute inset-2" />}
        {data && data.length === 0 && (
          <p className="absolute inset-0 grid place-items-center text-sm text-muted">
            No trades yet in this timeframe — place one!
          </p>
        )}
      </div>
    </Card>
  );
}
