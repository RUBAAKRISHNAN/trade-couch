import { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { Segmented, Skeleton } from '@/components/ui/primitives';
import { useInstruments, useSymbolStreams } from '@/hooks/data';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useUi } from '@/stores/ui';
import { AccountTabs } from './AccountTabs';
import { MarketHeader } from './MarketHeader';
import { OrderBookPanel } from './OrderBook';
import { OrderPanel } from './OrderPanel';
import { PriceChart } from './PriceChart';
import { TradeTape } from './TradeTape';
import { Watchlist } from './Watchlist';

type MobileTab = 'chart' | 'book' | 'trade' | 'orders';

export function TradePage() {
  const { symbol: param } = useParams();
  const { data: instruments, isLoading } = useInstruments();
  const symbol = param ?? 'BTC-INR';
  const inst = instruments?.find((i) => i.symbol === symbol);
  const setSymbol = useUi((s) => s.setSymbol);
  const focusOrder = useUi((s) => s.focusOrder);
  const [tab, setTab] = useState<MobileTab>('chart');

  useEffect(() => setSymbol(symbol), [symbol, setSymbol]);
  useSymbolStreams(symbol);
  useHotkeys(
    useMemo(
      () => ({
        b: () => {
          focusOrder('BUY');
          setTab('trade');
        },
        s: () => {
          focusOrder('SELL');
          setTab('trade');
        },
      }),
      [focusOrder],
    ),
  );

  if (isLoading)
    return (
      <div className="grid h-full gap-2 p-2 lg:grid-cols-[200px_1fr_280px_300px]">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-full min-h-64" />
        ))}
      </div>
    );
  if (!inst)
    return instruments?.[0] ? (
      <Navigate to={`/trade/${instruments[0].symbol}`} replace />
    ) : (
      <p className="p-6">No instruments available.</p>
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <MarketHeader inst={inst} />

      {/* desktop terminal layout */}
      <div className="hidden min-h-0 flex-1 gap-2 lg:grid lg:grid-cols-[200px_minmax(0,1fr)_270px_300px] lg:grid-rows-[minmax(0,1fr)_240px]">
        <div className="row-span-2 min-h-0">
          <Watchlist active={symbol} />
        </div>
        <div className="min-h-0">
          <PriceChart inst={inst} />
        </div>
        <div className="row-span-2 grid min-h-0 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] gap-2 xl:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]">
          <OrderBookPanel inst={inst} />
          <div className="hidden min-h-0 xl:block">
            <TradeTape inst={inst} />
          </div>
        </div>
        <div className="row-span-2 min-h-0">
          <OrderPanel inst={inst} />
        </div>
        <div className="min-h-0">
          <AccountTabs />
        </div>
      </div>

      {/* mobile: simplified tabs */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:hidden">
        <Segmented<MobileTab>
          value={tab}
          onChange={setTab}
          className="w-full justify-between"
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'book', label: 'Book' },
            { value: 'trade', label: 'Trade' },
            { value: 'orders', label: 'Orders' },
          ]}
        />
        <div className="min-h-[420px] flex-1">
          {tab === 'chart' && <PriceChart inst={inst} />}
          {tab === 'book' && <OrderBookPanel inst={inst} />}
          {tab === 'trade' && <OrderPanel inst={inst} />}
          {tab === 'orders' && <AccountTabs />}
        </div>
      </div>
    </div>
  );
}
