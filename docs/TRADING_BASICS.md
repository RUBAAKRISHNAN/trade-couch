# Trading basics (for beginners)

Everything TradeCore uses, in plain English. You don't need to trade to build an exchange — you need to know how one
works. The in-app **Learn** page shows each idea on the live market.

> TradeCore uses **virtual money** for learning. Nothing here is investment advice.

## The market

| Term                | Meaning                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Share / coin**    | A unit of something you can own (1 share of TCS, 1 Bitcoin). TradeCore lets you trade fractions (0.0001 BTC).                   |
| **Exchange**        | The marketplace where buyers and sellers meet (NSE, BSE). TradeCore is a small exchange of its own.                             |
| **Price**           | Not set by anyone. It's wherever a buyer and a seller agree. More eager buyers → up; more eager sellers → down.                 |
| **Reference price** | The real market price from live feeds (Coinbase, Binance). TradeCore's bots quote around it, so our price follows the real one. |

## The order book

A live list of everyone waiting to trade, at each price:

```
SELLERS (asks)    ₹103 × 50
                  ₹102 × 30
                  ₹101 × 20   ← best ask (lowest price a seller accepts)
── spread ₹2 ──
                  ₹99  × 40   ← best bid (highest price a buyer pays)
BUYERS (bids)     ₹98  × 25
```

- **Bid** — what buyers offer. **Ask** — what sellers want. **Spread** — the gap. A trade happens only when someone
  crosses the gap.
- **Depth** — how much is waiting near the price. The depth chart draws it.

## Order types

| Order                       | Says                                                | Example                                                               |
| --------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| **Market**                  | "Now, at the best available prices."                | Buy now → you pay ₹101 (and ₹102 for anything beyond the 20 at ₹101). |
| **Limit**                   | "Only at my price or better."                       | "Buy at ₹99 or less" → waits in the book until a seller comes down.   |
| **Stop-market (stop-loss)** | "If the price falls to X, sell at market."          | Bought at ₹100, stop at ₹95 → caps your loss automatically.           |
| **Stop-limit**              | "If the price reaches X, place a limit order at Y." | Like a stop, but won't sell below Y (it may not fill in a crash).     |

**Time in force**: **GTC** (stays until filled or cancelled), **IOC** (fill what you can now, cancel the rest), **FOK**
(all now or nothing).

**Slippage** — a big market order "walks" through several price levels, so its average price is worse than the best price.

## Matching: price-time priority

The matching engine pairs orders by two rules, like every real exchange:

1. **Best price first** — the highest bid and lowest ask trade first.
2. **At the same price, first come, first served.**

```
Asks: Asha 20 @ ₹101 (10:00:01), Kumar 30 @ ₹101 (10:00:05)
Ravi: BUY 30 at market
→ 20 from Asha @ ₹101 (she came first), 10 from Kumar @ ₹101
→ Kumar's other 20 keep waiting — a "partial fill"
```

Trades happen at the **resting** (maker) order's price, so an aggressive buyer can get a better price than they asked
for ("price improvement").

## Candles (OHLC)

Each candle summarises one time period (1 min, 5 min, 1 h, 1 day):
**Open** (first price), **High**, **Low**, **Close** (last price). Green = closed higher than it opened, red = lower.
Volume = how much traded in that period.

## Portfolio and P&L

- **Cash** — your money. **Held** — cash reserved for open buy orders (you can't spend it twice). **Available** = cash − held.
- **Equity** = cash + current value of everything you hold.
- **Unrealised P&L** — profit/loss on positions you still hold, at today's price ("on paper").
- **Realised P&L** — profit/loss locked in when you sell, versus your **average cost**.
- **Return %** = (equity − starting cash) ÷ starting cash.
- **Drawdown** — the drop from your highest equity to a later low. Big drawdowns are what end beginners' accounts.

## Liquidity and market makers

**Liquidity** = how easily you can trade without moving the price. **Market makers** always quote a bid and an ask,
earning the spread; their risk is **inventory** (holding too much of something that falls). TradeCore's market-maker
bots quote around the live reference price, skew their prices against their inventory, and stop quoting a side at
their limit. **Flow bots** trade small amounts so the book keeps moving.

## Risk: the part that matters most

- **Position size** — how much of your money is in one trade.
- **Risk per trade** — how much you lose if your **stop-loss** is hit. Professionals risk ~1% of equity per trade.
  Size follows from it: `units = (equity × risk %) ÷ (entry − stop)`. A 2% stop lets a 1%-risk position be 50% of your
  money; a 10% stop allows only 10%.
- **Risk : reward** — target distance ÷ stop distance. At 2 : 1 you can be wrong more than half the time and still win.

## What the Trade Coach checks (and why)

The Coach grades **process, not outcome**: a disciplined loss can earn an A, a lucky all-in win an F.

| Habit              | What it means                                       | Why it matters                                        |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------- |
| Stop-loss used     | You decided your exit before entering               | Caps the damage of being wrong                        |
| Small risk         | ≤ 1% of equity at risk to your stop                 | Survive losing streaks                                |
| Good risk : reward | Target ≥ 2 × stop distance                          | Winners pay for several losers                        |
| Followed plan      | Exited at your own stop or target                   | A plan only works if you follow it                    |
| FOMO               | Bought right after a sharp spike (≥ 1.5% in 15 min) | Spikes often reverse                                  |
| Revenge trade      | A bigger trade within 30 min of a loss              | Emotion trying to win it back                         |
| Overtrading        | 8+ trades in an hour                                | Quantity over quality                                 |
| Held a loser       | Held a losing trade > 2 × your usual winner         | "It'll come back" is how small losses become big ones |
