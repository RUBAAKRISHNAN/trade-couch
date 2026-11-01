/**
 * TRADE COACH — grades the PROCESS of a trade, not its outcome.
 *
 * A round trip is one position from flat → open → back to flat on one symbol (spot only, so positions
 * are always long). The coach looks at how it was traded: was risk controlled (stop-loss, position
 * size), was there a plan and was it followed, and were there emotional habits (chasing a spike,
 * revenge trading after a loss, overtrading, holding losers too long). A disciplined loss can earn an
 * A; a lucky all-in win with no stop earns an F. It never says what to buy or sell.
 */

// ───────────────────────────── round trips ─────────────────────────────

export interface CoachFill {
  orderId: number;
  side: 'BUY' | 'SELL';
  /** units */
  qty: number;
  /** paise */
  notional: number;
  ts: Date;
}

export interface OpenPosition {
  qty: number;
  openedAt: Date;
  buyUnits: number;
  buyNotional: number;
  sellUnits: number;
  sellNotional: number;
  entryOrderIds: number[];
  exitOrderIds: number[];
}

export interface ClosedTrip {
  /** units bought (= units sold) over the trip */
  qty: number;
  buyNotional: number;
  sellNotional: number;
  pnl: number;
  openedAt: Date;
  closedAt: Date;
  entryOrderIds: number[];
  exitOrderIds: number[];
}

const addId = (ids: number[], id: number) => (ids.includes(id) ? ids : [...ids, id]);

/**
 * Applies one fill to the account's tracked position for a symbol.
 * A SELL with no tracked position (units from before tracking started, e.g. a grant) is ignored; a SELL
 * larger than the tracked position only counts the tracked part (its notional pro-rated).
 */
export function applyFill(
  pos: OpenPosition | null,
  f: CoachFill,
): { pos: OpenPosition | null; closed?: ClosedTrip } {
  if (f.side === 'BUY') {
    if (!pos)
      return {
        pos: {
          qty: f.qty,
          openedAt: f.ts,
          buyUnits: f.qty,
          buyNotional: f.notional,
          sellUnits: 0,
          sellNotional: 0,
          entryOrderIds: [f.orderId],
          exitOrderIds: [],
        },
      };
    return {
      pos: {
        ...pos,
        qty: pos.qty + f.qty,
        buyUnits: pos.buyUnits + f.qty,
        buyNotional: pos.buyNotional + f.notional,
        entryOrderIds: addId(pos.entryOrderIds, f.orderId),
      },
    };
  }
  if (!pos) return { pos: null };
  const used = Math.min(f.qty, pos.qty);
  const usedNotional = used === f.qty ? f.notional : Math.round((f.notional * used) / f.qty);
  const next: OpenPosition = {
    ...pos,
    qty: pos.qty - used,
    sellUnits: pos.sellUnits + used,
    sellNotional: pos.sellNotional + usedNotional,
    exitOrderIds: addId(pos.exitOrderIds, f.orderId),
  };
  if (next.qty > 0) return { pos: next };
  return {
    pos: null,
    closed: {
      qty: next.buyUnits,
      buyNotional: next.buyNotional,
      sellNotional: next.sellNotional,
      pnl: next.sellNotional - next.buyNotional,
      openedAt: next.openedAt,
      closedAt: f.ts,
      entryOrderIds: next.entryOrderIds,
      exitOrderIds: next.exitOrderIds,
    },
  };
}

// ───────────────────────────── grading ─────────────────────────────

export type CoachFlag =
  | 'STOP_USED'
  | 'SMALL_SIZE'
  | 'GOOD_RR'
  | 'FOLLOWED_PLAN'
  | 'NO_STOP'
  | 'OVERSIZED'
  | 'ALL_IN'
  | 'POOR_RR'
  | 'BROKE_STOP'
  | 'FOMO'
  | 'REVENGE'
  | 'OVERTRADING'
  | 'HELD_LOSER';

export interface FlagInfo {
  good: boolean;
  /** points added to (or taken from) the base score */
  points: number;
  label: string;
  explain: string;
  tip: string;
  /** a weekly goal when this is a recurring habit (bad flags only) */
  goal?: string;
}

export const COACH_FLAGS: Record<CoachFlag, FlagInfo> = {
  STOP_USED: {
    good: true,
    points: 15,
    label: 'Used a stop-loss',
    explain: 'You decided in advance where you would get out if the price fell.',
    tip: 'Keep setting a stop-loss on every trade — it caps the damage of a bad one.',
  },
  SMALL_SIZE: {
    good: true,
    points: 10,
    label: 'Small position',
    explain: 'You risked 5% of your money or less on this trade.',
    tip: 'Small positions let you survive a losing streak. Keep it up.',
  },
  GOOD_RR: {
    good: true,
    points: 10,
    label: 'Good risk : reward',
    explain: 'Your target was at least twice as far as your stop — winners can pay for several losers.',
    tip: 'Planning targets at 2× your risk means you can be wrong often and still come out ahead.',
  },
  FOLLOWED_PLAN: {
    good: true,
    points: 10,
    label: 'Followed your plan',
    explain: 'You exited at your own target or stop instead of improvising.',
    tip: 'Sticking to the plan is what turns a strategy into results.',
  },
  NO_STOP: {
    good: false,
    points: -15,
    label: 'No stop-loss',
    explain: 'Nothing limited how much this trade could lose.',
    tip: 'Before you buy, decide the price where you are wrong and place a stop-loss there.',
    goal: 'Use a stop-loss on every trade this week.',
  },
  OVERSIZED: {
    good: false,
    points: -10,
    label: 'Large position',
    explain: 'More than 10% of your money was in this one trade.',
    tip: 'Try risking 5% or less per trade so one loss cannot hurt you much.',
    goal: 'Keep every trade at 5% of your money or less.',
  },
  ALL_IN: {
    good: false,
    points: -25,
    label: 'Very large position',
    explain: 'More than a quarter of your money was in this one trade.',
    tip: 'A few trades this size going wrong can wipe out weeks of progress. Size down.',
    goal: 'Never put more than 10% of your money in one trade.',
  },
  POOR_RR: {
    good: false,
    points: -5,
    label: 'Weak risk : reward',
    explain: 'Your planned target was closer than your stop — you risked more than you hoped to make.',
    tip: 'Look for trades where the target is at least as far away as the stop, ideally twice.',
  },
  BROKE_STOP: {
    good: false,
    points: -15,
    label: 'Ignored your stop',
    explain: 'You sold well below the stop you planned, so the loss was bigger than intended.',
    tip: 'Place the stop as a real order when you enter, so you can’t talk yourself out of it.',
    goal: 'Place your planned stop as an order the moment you enter.',
  },
  FOMO: {
    good: false,
    points: -10,
    label: 'Chased a spike (FOMO)',
    explain: 'You bought right after the price jumped quickly, often near a short-term top.',
    tip: 'After a sudden jump, wait for the price to settle before deciding to buy.',
    goal: 'Wait 15 minutes after any sharp move before entering.',
  },
  REVENGE: {
    good: false,
    points: -20,
    label: 'Revenge trade',
    explain: 'You made a bigger trade soon after a loss — usually emotion trying to win it back.',
    tip: 'After a loss, take a short break. Your next trade should be the same size or smaller.',
    goal: 'After a losing trade, wait 30 minutes and don’t increase your size.',
  },
  OVERTRADING: {
    good: false,
    points: -10,
    label: 'Overtrading',
    explain: 'You opened 8 or more trades within an hour.',
    tip: 'Fewer, better-planned trades usually beat many quick ones. Trade only your best setups.',
    goal: 'Make at most 5 trades a day, each with a written plan.',
  },
  HELD_LOSER: {
    good: false,
    points: -10,
    label: 'Held a loser too long',
    explain: 'You held this losing trade more than twice as long as you usually hold winners.',
    tip: 'Losers deserve less patience than winners. Let your stop-loss make the decision.',
    goal: 'Exit losing trades at your stop instead of waiting for them to come back.',
  },
};

export const COACH_BASE_SCORE = 60;

export interface TripFacts {
  pnl: number;
  /** paise spent on entry (all buys) */
  entryNotional: number;
  /** account equity when the trip opened, paise */
  equityAtOpen: number;
  /** average entry / exit price per whole coin or share, paise */
  entryPrice: number;
  exitPrice: number;
  planStop?: number | null;
  planTarget?: number | null;
  /** a stop order was placed to protect this position */
  hadStopOrder: boolean;
  /** % price move over the 15 minutes before entry (positive = up), if known */
  moveBeforeEntryPct?: number | null;
  /** the account's previous round trip on any symbol, closed before this one opened */
  prevTrip?: { pnl: number; closedAt: Date; entryNotional: number } | null;
  openedAt: Date;
  closedAt: Date;
  /** round trips this account opened in the hour before this one */
  tripsOpenedLastHour: number;
  /** median holding time of the account's earlier winning trips (needs ≥ 3), minutes */
  medianWinHoldMinutes?: number | null;
}

export interface TripGrade {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  flags: CoachFlag[];
  tip: string;
  details: {
    sizePct: number;
    plannedRR: number | null;
    holdMinutes: number;
    moveBeforeEntryPct: number | null;
    returnPct: number;
  };
}

export const FOMO_MOVE_PCT = 1.5;
export const REVENGE_WINDOW_MIN = 30;
export const REVENGE_SIZE_RATIO = 1.5;
export const OVERTRADING_PER_HOUR = 8;

export function gradeFromScore(score: number): TripGrade['grade'] {
  return score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
}

export function gradeTrip(f: TripFacts): TripGrade {
  const flags: CoachFlag[] = [];
  const holdMinutes = Math.max(0, (f.closedAt.getTime() - f.openedAt.getTime()) / 60_000);
  const sizePct = f.equityAtOpen > 0 ? (f.entryNotional / f.equityAtOpen) * 100 : 100;

  // risk control
  const hasStop = f.hadStopOrder || !!f.planStop;
  flags.push(hasStop ? 'STOP_USED' : 'NO_STOP');
  if (sizePct <= 5) flags.push('SMALL_SIZE');
  else if (sizePct > 25) flags.push('ALL_IN');
  else if (sizePct > 10) flags.push('OVERSIZED');

  // the plan
  let plannedRR: number | null = null;
  if (f.planStop && f.planTarget && f.entryPrice > f.planStop) {
    plannedRR = (f.planTarget - f.entryPrice) / (f.entryPrice - f.planStop);
    if (plannedRR >= 2) flags.push('GOOD_RR');
    else if (plannedRR < 1) flags.push('POOR_RR');
  }
  if (f.planStop && f.exitPrice < f.planStop * 0.99) flags.push('BROKE_STOP');
  else if (
    (f.planTarget && f.exitPrice >= f.planTarget * 0.995) ||
    (f.planStop && f.exitPrice <= f.planStop * 1.005)
  )
    flags.push('FOLLOWED_PLAN');

  // habits
  const move = f.moveBeforeEntryPct ?? null;
  if (move !== null && move >= FOMO_MOVE_PCT) flags.push('FOMO');
  if (
    f.prevTrip &&
    f.prevTrip.pnl < 0 &&
    f.openedAt.getTime() - f.prevTrip.closedAt.getTime() <= REVENGE_WINDOW_MIN * 60_000 &&
    f.entryNotional >= f.prevTrip.entryNotional * REVENGE_SIZE_RATIO
  )
    flags.push('REVENGE');
  if (f.tripsOpenedLastHour >= OVERTRADING_PER_HOUR) flags.push('OVERTRADING');
  if (f.pnl < 0 && f.medianWinHoldMinutes && holdMinutes > 2 * f.medianWinHoldMinutes)
    flags.push('HELD_LOSER');

  const raw = flags.reduce((s, fl) => s + COACH_FLAGS[fl].points, COACH_BASE_SCORE);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  // the tip addresses the most costly mistake; with none, it reinforces the best habit
  const bad = flags
    .filter((fl) => !COACH_FLAGS[fl].good)
    .sort((a, b) => COACH_FLAGS[a].points - COACH_FLAGS[b].points);
  const good = flags
    .filter((fl) => COACH_FLAGS[fl].good)
    .sort((a, b) => COACH_FLAGS[b].points - COACH_FLAGS[a].points);
  const tip = bad[0]
    ? COACH_FLAGS[bad[0]].tip
    : good[0]
      ? COACH_FLAGS[good[0]].tip
      : 'Plan your stop and target before you enter.';

  return {
    score,
    grade: gradeFromScore(score),
    flags,
    tip,
    details: {
      sizePct: Math.round(sizePct * 100) / 100,
      plannedRR: plannedRR === null ? null : Math.round(plannedRR * 100) / 100,
      holdMinutes: Math.round(holdMinutes * 10) / 10,
      moveBeforeEntryPct: move === null ? null : Math.round(move * 100) / 100,
      returnPct: f.entryNotional ? Math.round((f.pnl / f.entryNotional) * 10_000) / 100 : 0,
    },
  };
}

/**
 * Weekly Skill Score: mostly the average process score, plus a consistency bonus for using stops.
 * Outcome (profit) is deliberately not part of it.
 */
export function weeklySkillScore(avgTripScore: number, stopRate: number): number {
  return Math.max(0, Math.min(100, Math.round(0.75 * avgTripScore + 25 * stopRate)));
}

/** Habits = bad flags seen in at least a quarter of the week's trips; the goal targets the costliest. */
export function weeklyGoal(habits: CoachFlag[]): string {
  const sorted = [...habits].sort((a, b) => COACH_FLAGS[a].points - COACH_FLAGS[b].points);
  const g = sorted.map((h) => COACH_FLAGS[h].goal).find(Boolean);
  return g ?? 'Keep your process: plan a stop and target before every trade, and size small.';
}
