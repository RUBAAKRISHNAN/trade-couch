import {
  applyFill,
  COACH_FLAGS,
  gradeTrip,
  weeklyGoal,
  weeklySkillScore,
  type ClosedTrip,
  type CoachFlag,
  type OpenPosition,
} from '@tradecore/shared';
import { withTx, type Pool, type PoolClient } from '@tradecore/shared/node';

/**
 * TRADE COACH processor (run by the worker every few seconds).
 *
 * Per symbol, inside ONE transaction:
 *   1. lock coach_cursors(symbol) and read the next settled trades by engine seq (seq order = settle order,
 *      because one settler per symbol commits batches in sequence)
 *   2. replay each human account's fills through applyFill() against its tracked open position
 *   3. for every position that went back to flat, write a round_trips row and grade it (coach_reports)
 *   4. save the open positions and advance the cursor
 * If anything fails the whole batch rolls back and is retried next run, so each trade is coached once.
 */

interface TradeRow {
  seq: number;
  qty_units: number;
  notional_paise: number;
  executed_at: Date;
  buy_order_id: number;
  sell_order_id: number;
  buyer_account_id: number;
  seller_account_id: number;
  buyer_human: boolean;
  seller_human: boolean;
}

export interface CoachRunResult {
  trades: number;
  roundTrips: number;
  weeks: number;
  badges: number;
}

export async function runCoach(pool: Pool, opts: { batch?: number } = {}): Promise<CoachRunResult> {
  const symbols = (await pool.query<{ symbol: string }>('SELECT symbol FROM instruments')).rows.map(
    (r) => r.symbol,
  );
  let trades = 0;
  let roundTrips = 0;
  for (const symbol of symbols) {
    // keep draining a symbol until it is caught up
    for (;;) {
      const r = await withTx(pool, (c) => coachSymbolBatch(c, symbol, opts.batch ?? 2000));
      trades += r.trades;
      roundTrips += r.roundTrips;
      if (!r.more) break;
    }
  }
  const weeks = await rollUpWeeks(pool);
  const badges = await awardBadges(pool);
  return { trades, roundTrips, weeks, badges };
}

async function coachSymbolBatch(c: PoolClient, symbol: string, batch: number) {
  await c.query('INSERT INTO coach_cursors (symbol) VALUES ($1) ON CONFLICT DO NOTHING', [symbol]);
  const lastSeq = (
    await c.query<{ last_seq: number }>('SELECT last_seq FROM coach_cursors WHERE symbol = $1 FOR UPDATE', [
      symbol,
    ])
  ).rows[0]!.last_seq;
  const rows = (
    await c.query<TradeRow>(
      `SELECT t.seq, t.qty_units, t.notional_paise, t.executed_at, t.buy_order_id, t.sell_order_id,
              t.buyer_account_id, t.seller_account_id,
              ub.role <> 'BOT' AS buyer_human, us.role <> 'BOT' AS seller_human
       FROM trades t
       JOIN accounts ab ON ab.id = t.buyer_account_id JOIN users ub ON ub.id = ab.user_id
       JOIN accounts asl ON asl.id = t.seller_account_id JOIN users us ON us.id = asl.user_id
       WHERE t.symbol = $1 AND t.seq > $2 ORDER BY t.seq LIMIT $3`,
      [symbol, lastSeq, batch],
    )
  ).rows;
  if (!rows.length) return { trades: 0, roundTrips: 0, more: false };

  // load the tracked positions of every human account in this batch (locked: we rewrite them)
  const accountIds = [
    ...new Set(
      rows.flatMap((t) => [
        ...(t.buyer_human ? [t.buyer_account_id] : []),
        ...(t.seller_human ? [t.seller_account_id] : []),
      ]),
    ),
  ].sort((a, b) => a - b);
  const positions = new Map<number, OpenPosition | null>();
  if (accountIds.length) {
    const p = await c.query(
      `SELECT * FROM coach_positions WHERE symbol = $1 AND account_id = ANY($2::bigint[]) ORDER BY account_id FOR UPDATE`,
      [symbol, accountIds],
    );
    for (const r of p.rows)
      positions.set(r.account_id, {
        qty: r.qty_units,
        openedAt: r.opened_at,
        buyUnits: r.buy_units,
        buyNotional: r.buy_notional,
        sellUnits: r.sell_units,
        sellNotional: r.sell_notional,
        entryOrderIds: r.entry_order_ids.map(Number),
        exitOrderIds: r.exit_order_ids.map(Number),
      });
  }

  const closed: { accountId: number; trip: ClosedTrip }[] = [];
  const step = (accountId: number, side: 'BUY' | 'SELL', orderId: number, t: TradeRow) => {
    const r = applyFill(positions.get(accountId) ?? null, {
      orderId,
      side,
      qty: t.qty_units,
      notional: t.notional_paise,
      ts: t.executed_at,
    });
    positions.set(accountId, r.pos);
    if (r.closed) closed.push({ accountId, trip: r.closed });
  };
  for (const t of rows) {
    if (t.buyer_human) step(t.buyer_account_id, 'BUY', t.buy_order_id, t);
    if (t.seller_human) step(t.seller_account_id, 'SELL', t.sell_order_id, t);
  }

  for (const [accountId, pos] of positions) {
    if (!pos) {
      await c.query('DELETE FROM coach_positions WHERE account_id = $1 AND symbol = $2', [accountId, symbol]);
      continue;
    }
    await c.query(
      `INSERT INTO coach_positions (account_id, symbol, qty_units, opened_at, buy_units, buy_notional, sell_units,
                                    sell_notional, entry_order_ids, exit_order_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (account_id, symbol) DO UPDATE SET qty_units = EXCLUDED.qty_units, opened_at = EXCLUDED.opened_at,
         buy_units = EXCLUDED.buy_units, buy_notional = EXCLUDED.buy_notional, sell_units = EXCLUDED.sell_units,
         sell_notional = EXCLUDED.sell_notional, entry_order_ids = EXCLUDED.entry_order_ids,
         exit_order_ids = EXCLUDED.exit_order_ids`,
      [
        accountId,
        symbol,
        pos.qty,
        pos.openedAt,
        pos.buyUnits,
        pos.buyNotional,
        pos.sellUnits,
        pos.sellNotional,
        pos.entryOrderIds,
        pos.exitOrderIds,
      ],
    );
  }

  const qtyScale = (
    await c.query<{ qty_scale: number }>('SELECT qty_scale FROM instruments WHERE symbol = $1', [symbol])
  ).rows[0]!.qty_scale;
  let roundTrips = 0;
  for (const { accountId, trip } of closed) {
    if (await recordTrip(c, accountId, symbol, qtyScale, trip)) roundTrips++;
  }

  await c.query('UPDATE coach_cursors SET last_seq = $2, updated_at = now() WHERE symbol = $1', [
    symbol,
    rows[rows.length - 1]!.seq,
  ]);
  return { trades: rows.length, roundTrips, more: rows.length === batch };
}

/** Gathers the context a grade needs (all from data already in the database), writes the trip and its report. */
export async function recordTrip(
  c: PoolClient,
  accountId: number,
  symbol: string,
  qtyScale: number,
  trip: ClosedTrip,
  source: 'live' | 'seed' = 'live',
  seedFacts?: {
    planStop?: number | null;
    planTarget?: number | null;
    hadStopOrder?: boolean;
    moveBeforeEntryPct?: number;
  },
): Promise<boolean> {
  const entryPrice = Math.round((trip.buyNotional * qtyScale) / trip.qty);
  const exitPrice = Math.round((trip.sellNotional * qtyScale) / trip.qty);

  const plan = seedFacts
    ? { plan_stop_paise: seedFacts.planStop ?? null, plan_target_paise: seedFacts.planTarget ?? null }
    : ((
        await c.query<{ plan_stop_paise: number | null; plan_target_paise: number | null }>(
          `SELECT plan_stop_paise, plan_target_paise FROM orders
           WHERE id = ANY($1::bigint[]) AND (plan_stop_paise IS NOT NULL OR plan_target_paise IS NOT NULL)
           ORDER BY id LIMIT 1`,
          [trip.entryOrderIds],
        )
      ).rows[0] ?? { plan_stop_paise: null, plan_target_paise: null });

  const hadStopOrder =
    seedFacts?.hadStopOrder ??
    (
      await c.query<{ x: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM orders WHERE account_id = $1 AND symbol = $2 AND side = 'SELL'
           AND type IN ('STOP_MARKET', 'STOP_LIMIT') AND created_at BETWEEN $3::timestamptz - interval '1 minute' AND $4) AS x`,
        [accountId, symbol, trip.openedAt, trip.closedAt],
      )
    ).rows[0]!.x;

  const ctx = (
    await c.query<{
      equity: number | null;
      starting: number;
      prev_pnl: number | null;
      prev_closed: Date | null;
      prev_notional: number | null;
      last_hour: number;
      median_win_min: number | null;
      wins: number;
      pre_price: number | null;
    }>(
      `SELECT
         (SELECT equity_paise FROM equity_snapshots WHERE account_id = $1 AND ts <= $2 ORDER BY ts DESC LIMIT 1) AS equity,
         (SELECT starting_cash_paise FROM accounts WHERE id = $1) AS starting,
         p.pnl_paise AS prev_pnl, p.closed_at AS prev_closed, p.entry_notional AS prev_notional,
         (SELECT count(*)::int FROM round_trips WHERE account_id = $1 AND opened_at >= $2::timestamptz - interval '1 hour'
            AND opened_at < $2) AS last_hour,
         w.median_min AS median_win_min, w.n AS wins,
         (SELECT price_paise FROM trades WHERE symbol = $3 AND executed_at <= $2::timestamptz - interval '15 minutes'
            AND executed_at > $2::timestamptz - interval '2 hours' ORDER BY executed_at DESC LIMIT 1) AS pre_price
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (
         SELECT r.pnl_paise, r.closed_at, r.entry_avg_paise * r.qty_units / i.qty_scale AS entry_notional
         FROM round_trips r JOIN instruments i ON i.symbol = r.symbol
         WHERE r.account_id = $1 AND r.closed_at <= $2 ORDER BY r.closed_at DESC LIMIT 1) p ON true
       LEFT JOIN LATERAL (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - opened_at) / 60) AS median_min,
                count(*)::int AS n
         FROM (SELECT opened_at, closed_at FROM round_trips WHERE account_id = $1 AND pnl_paise > 0 AND closed_at <= $2
               ORDER BY closed_at DESC LIMIT 50) wins) w ON true`,
      [accountId, trip.openedAt, symbol],
    )
  ).rows[0]!;

  const equityAtOpen = ctx.equity && ctx.equity > 0 ? ctx.equity : ctx.starting;
  const moveBeforeEntryPct =
    seedFacts?.moveBeforeEntryPct ??
    (ctx.pre_price ? ((entryPrice - ctx.pre_price) / ctx.pre_price) * 100 : null);

  const grade = gradeTrip({
    pnl: trip.pnl,
    entryNotional: trip.buyNotional,
    equityAtOpen,
    entryPrice,
    exitPrice,
    planStop: plan.plan_stop_paise,
    planTarget: plan.plan_target_paise,
    hadStopOrder,
    moveBeforeEntryPct,
    prevTrip:
      ctx.prev_closed && ctx.prev_pnl !== null
        ? { pnl: ctx.prev_pnl, closedAt: ctx.prev_closed, entryNotional: Number(ctx.prev_notional) }
        : null,
    openedAt: trip.openedAt,
    closedAt: trip.closedAt,
    tripsOpenedLastHour: ctx.last_hour,
    medianWinHoldMinutes: ctx.wins >= 3 ? ctx.median_win_min : null,
  });

  const ins = await c.query<{ id: number }>(
    `INSERT INTO round_trips (account_id, symbol, qty_units, entry_avg_paise, exit_avg_paise, pnl_paise,
                              equity_at_open_paise, opened_at, closed_at, plan_stop_paise, plan_target_paise,
                              had_stop_order, entry_order_ids, exit_order_ids, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (account_id, symbol, opened_at) DO NOTHING RETURNING id`,
    [
      accountId,
      symbol,
      trip.qty,
      entryPrice,
      exitPrice,
      trip.pnl,
      equityAtOpen,
      trip.openedAt,
      trip.closedAt,
      plan.plan_stop_paise,
      plan.plan_target_paise,
      hadStopOrder,
      trip.entryOrderIds,
      trip.exitOrderIds,
      source,
    ],
  );
  const id = ins.rows[0]?.id;
  if (!id) return false;
  await c.query(
    `INSERT INTO coach_reports (round_trip_id, grade, score, flags, tip, details) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, grade.grade, grade.score, grade.flags, grade.tip, JSON.stringify(grade.details)],
  );
  return true;
}

/**
 * Weekly Skill Score per account, rebuilt for recent weeks with SQL aggregates and window functions:
 *  - FILTER aggregates for average win / average loss
 *  - unnest(flags) to count how often each habit appeared
 *  - a running MAX() OVER (PARTITION BY account, week ORDER BY ts) of equity → max drawdown
 */
export async function rollUpWeeks(pool: Pool, weeksBack = 2): Promise<number> {
  const r = await pool.query<{
    account_id: number;
    week_start: Date;
    trades: number;
    avg_score: number;
    stop_rate: number;
    win_rate: number;
    avg_win: number | null;
    avg_loss: number | null;
    max_dd: number | null;
    flags: { flag: CoachFlag; n: number }[] | null;
  }>(
    `WITH trips AS (
       SELECT r.account_id, date_trunc('week', r.closed_at)::date AS week_start, r.pnl_paise,
              (r.had_stop_order OR r.plan_stop_paise IS NOT NULL) AS stopped, c.score, c.flags
       FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id
       WHERE r.closed_at >= date_trunc('week', now()) - make_interval(weeks => $1)),
     wk AS (
       SELECT account_id, week_start, count(*)::int AS trades, avg(score)::float AS avg_score,
              avg(stopped::int)::float AS stop_rate, avg((pnl_paise > 0)::int)::float AS win_rate,
              round(avg(pnl_paise) FILTER (WHERE pnl_paise > 0))::bigint AS avg_win,
              round(avg(pnl_paise) FILTER (WHERE pnl_paise <= 0))::bigint AS avg_loss
       FROM trips GROUP BY 1, 2),
     fl AS (
       SELECT account_id, week_start, jsonb_agg(jsonb_build_object('flag', flag, 'n', n)) AS flags
       FROM (SELECT account_id, week_start, f AS flag, count(*)::int AS n FROM trips, unnest(flags) f GROUP BY 1, 2, 3) x
       GROUP BY 1, 2),
     dd AS (
       SELECT account_id, week_start, min(equity_paise - peak) AS max_dd
       FROM (SELECT account_id, date_trunc('week', ts)::date AS week_start, equity_paise,
                    max(equity_paise) OVER (PARTITION BY account_id, date_trunc('week', ts) ORDER BY ts) AS peak
             FROM equity_snapshots WHERE ts >= date_trunc('week', now()) - make_interval(weeks => $1)) s
       GROUP BY 1, 2)
     SELECT wk.*, dd.max_dd, fl.flags
     FROM wk LEFT JOIN fl USING (account_id, week_start) LEFT JOIN dd USING (account_id, week_start)`,
    [weeksBack],
  );
  for (const w of r.rows) {
    const habits = (w.flags ?? [])
      .filter((f) => COACH_FLAGS[f.flag] && !COACH_FLAGS[f.flag].good && f.n >= Math.max(1, 0.25 * w.trades))
      .map((f) => f.flag);
    await pool.query(
      `INSERT INTO weekly_skill (account_id, week_start, skill_score, trades, win_rate, avg_win_paise, avg_loss_paise,
                                 max_drawdown_paise, habits, goal, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (account_id, week_start) DO UPDATE SET skill_score = EXCLUDED.skill_score, trades = EXCLUDED.trades,
         win_rate = EXCLUDED.win_rate, avg_win_paise = EXCLUDED.avg_win_paise, avg_loss_paise = EXCLUDED.avg_loss_paise,
         max_drawdown_paise = EXCLUDED.max_drawdown_paise, habits = EXCLUDED.habits, goal = EXCLUDED.goal, computed_at = now()`,
      [
        w.account_id,
        w.week_start,
        weeklySkillScore(w.avg_score, w.stop_rate),
        w.trades,
        w.win_rate.toFixed(4),
        w.avg_win,
        w.avg_loss,
        w.max_dd === null ? null : Math.min(0, Number(w.max_dd)),
        habits,
        weeklyGoal(habits),
      ],
    );
  }
  return r.rows.length;
}

/** Badges are pure SQL: each is a HAVING count(*) >= N over the user's graded round trips. Idempotent. */
export async function awardBadges(pool: Pool): Promise<number> {
  const r = await pool.query(
    `INSERT INTO user_badges (user_id, badge_code)
     SELECT user_id, code FROM (
       SELECT a.user_id, 'FIRST_TRIP' AS code FROM round_trips r JOIN accounts a ON a.id = r.account_id GROUP BY 1
       UNION ALL
       SELECT a.user_id, 'STOP_10' FROM round_trips r JOIN accounts a ON a.id = r.account_id
         WHERE r.had_stop_order OR r.plan_stop_paise IS NOT NULL GROUP BY 1 HAVING count(*) >= 10
       UNION ALL
       SELECT a.user_id, 'SMALL_RISK_10' FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id
         JOIN accounts a ON a.id = r.account_id WHERE 'SMALL_SIZE' = ANY (c.flags) GROUP BY 1 HAVING count(*) >= 10
       UNION ALL
       SELECT a.user_id, 'A_GRADE_5' FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id
         JOIN accounts a ON a.id = r.account_id WHERE c.grade = 'A' GROUP BY 1 HAVING count(*) >= 5
       UNION ALL
       SELECT a.user_id, 'PLAN_5' FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id
         JOIN accounts a ON a.id = r.account_id WHERE 'FOLLOWED_PLAN' = ANY (c.flags) GROUP BY 1 HAVING count(*) >= 5
       UNION ALL
       SELECT DISTINCT a.user_id, 'STEADY_WEEK' FROM weekly_skill w JOIN accounts a ON a.id = w.account_id
         WHERE w.trades >= 5 AND w.skill_score >= 80
     ) earned
     WHERE code IN (SELECT code FROM badges) -- a badge missing from the catalogue is skipped, not fatal
     ON CONFLICT DO NOTHING`,
  );
  return r.rowCount ?? 0;
}
