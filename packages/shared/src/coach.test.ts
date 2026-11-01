import { describe, expect, it } from 'vitest';
import {
  applyFill,
  gradeTrip,
  weeklyGoal,
  weeklySkillScore,
  type OpenPosition,
  type TripFacts,
} from './coach';

const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, 0) + min * 60_000);

describe('applyFill (round trips)', () => {
  it('opens on a buy, adds on more buys, closes when back to flat', () => {
    let pos: OpenPosition | null = null;
    pos = applyFill(pos, { orderId: 1, side: 'BUY', qty: 10, notional: 1_000, ts: t(0) }).pos;
    pos = applyFill(pos, { orderId: 2, side: 'BUY', qty: 10, notional: 1_200, ts: t(5) }).pos;
    expect(pos).toMatchObject({ qty: 20, buyUnits: 20, buyNotional: 2_200, entryOrderIds: [1, 2] });

    const partial = applyFill(pos, { orderId: 3, side: 'SELL', qty: 5, notional: 600, ts: t(10) });
    expect(partial.closed).toBeUndefined();
    const done = applyFill(partial.pos, { orderId: 4, side: 'SELL', qty: 15, notional: 1_800, ts: t(20) });
    expect(done.pos).toBeNull();
    expect(done.closed).toMatchObject({
      qty: 20,
      buyNotional: 2_200,
      sellNotional: 2_400,
      pnl: 200,
      entryOrderIds: [1, 2],
      exitOrderIds: [3, 4],
    });
    expect(done.closed!.openedAt).toEqual(t(0));
    expect(done.closed!.closedAt).toEqual(t(20));
  });

  it('ignores sells of units that were never tracked and pro-rates an oversized sell', () => {
    expect(applyFill(null, { orderId: 9, side: 'SELL', qty: 5, notional: 500, ts: t(0) })).toEqual({
      pos: null,
    });
    const pos = applyFill(null, { orderId: 1, side: 'BUY', qty: 4, notional: 400, ts: t(0) }).pos;
    const r = applyFill(pos, { orderId: 2, side: 'SELL', qty: 8, notional: 1_000, ts: t(1) });
    expect(r.closed).toMatchObject({ qty: 4, sellNotional: 500, pnl: 100 });
  });

  it('counts each order id once even when it fills in several pieces', () => {
    let pos = applyFill(null, { orderId: 1, side: 'BUY', qty: 1, notional: 100, ts: t(0) }).pos;
    pos = applyFill(pos, { orderId: 1, side: 'BUY', qty: 1, notional: 100, ts: t(0) }).pos;
    expect(pos!.entryOrderIds).toEqual([1]);
  });
});

const base: TripFacts = {
  pnl: -500,
  entryNotional: 4_000_00,
  equityAtOpen: 1_00_000_00,
  entryPrice: 100_00,
  exitPrice: 98_00,
  planStop: 98_00,
  planTarget: 105_00,
  hadStopOrder: true,
  moveBeforeEntryPct: 0.2,
  prevTrip: null,
  openedAt: t(0),
  closedAt: t(30),
  tripsOpenedLastHour: 1,
  medianWinHoldMinutes: null,
};

describe('gradeTrip (process, not outcome)', () => {
  it('a disciplined LOSS earns an A: stop used, small size, good R:R, exited at the stop', () => {
    const g = gradeTrip(base);
    expect(g.grade).toBe('A');
    expect(g.flags).toEqual(expect.arrayContaining(['STOP_USED', 'SMALL_SIZE', 'GOOD_RR', 'FOLLOWED_PLAN']));
    expect(g.details.plannedRR).toBe(2.5);
    expect(g.details.sizePct).toBe(4);
  });

  it('a lucky all-in WIN with no stop earns an F', () => {
    const g = gradeTrip({
      ...base,
      pnl: 20_000_00,
      entryNotional: 90_000_00,
      exitPrice: 120_00,
      planStop: null,
      planTarget: null,
      hadStopOrder: false,
    });
    expect(g.flags).toEqual(expect.arrayContaining(['NO_STOP', 'ALL_IN']));
    expect(g.grade).toBe('F');
    expect(g.tip).toMatch(/Size down|wipe out/);
  });

  it('flags FOMO after a sharp move up before entry', () => {
    expect(gradeTrip({ ...base, moveBeforeEntryPct: 2 }).flags).toContain('FOMO');
    expect(gradeTrip({ ...base, moveBeforeEntryPct: 1 }).flags).not.toContain('FOMO');
  });

  it('flags REVENGE: a bigger trade within 30 minutes of a loss', () => {
    const prevTrip = { pnl: -1_000_00, closedAt: t(-10), entryNotional: 2_000_00 };
    expect(gradeTrip({ ...base, prevTrip }).flags).toContain('REVENGE');
    // same size, or after a long break, or after a win → not revenge
    expect(gradeTrip({ ...base, prevTrip: { ...prevTrip, entryNotional: 4_000_00 } }).flags).not.toContain(
      'REVENGE',
    );
    expect(gradeTrip({ ...base, prevTrip: { ...prevTrip, closedAt: t(-45) } }).flags).not.toContain(
      'REVENGE',
    );
    expect(gradeTrip({ ...base, prevTrip: { ...prevTrip, pnl: 100 } }).flags).not.toContain('REVENGE');
  });

  it('flags OVERTRADING and HELD_LOSER', () => {
    expect(gradeTrip({ ...base, tripsOpenedLastHour: 8 }).flags).toContain('OVERTRADING');
    const held = gradeTrip({ ...base, closedAt: t(90), medianWinHoldMinutes: 20 });
    expect(held.flags).toContain('HELD_LOSER');
    // a winner held long is not a "held loser"
    expect(gradeTrip({ ...base, pnl: 100, closedAt: t(90), medianWinHoldMinutes: 20 }).flags).not.toContain(
      'HELD_LOSER',
    );
  });

  it('flags BROKE_STOP when the exit is well below the planned stop', () => {
    const g = gradeTrip({ ...base, hadStopOrder: false, exitPrice: 95_00 });
    expect(g.flags).toContain('BROKE_STOP');
    expect(g.flags).not.toContain('FOLLOWED_PLAN');
  });

  it('size bands: ≤5% small, >10% oversized, >25% all-in', () => {
    const at = (pct: number) => gradeTrip({ ...base, entryNotional: pct * 1_000_00 }).flags;
    expect(at(5)).toContain('SMALL_SIZE');
    expect(at(8)).not.toEqual(expect.arrayContaining(['SMALL_SIZE']));
    expect(at(15)).toContain('OVERSIZED');
    expect(at(30)).toContain('ALL_IN');
  });

  it('score is clamped to 0–100 and the tip targets the most costly mistake', () => {
    const g = gradeTrip({
      ...base,
      planStop: null,
      planTarget: null,
      hadStopOrder: false,
      entryNotional: 50_000_00,
      moveBeforeEntryPct: 5,
      tripsOpenedLastHour: 12,
      prevTrip: { pnl: -1, closedAt: t(-1), entryNotional: 1 },
    });
    expect(g.score).toBe(0);
    expect(g.tip).toMatch(/Size down/); // ALL_IN (−25) outranks REVENGE (−20)
  });
});

describe('weekly roll-up helpers', () => {
  it('skill score blends process score with stop usage, ignoring profit', () => {
    expect(weeklySkillScore(80, 1)).toBe(85);
    expect(weeklySkillScore(80, 0)).toBe(60);
    expect(weeklySkillScore(120, 1)).toBe(100);
  });
  it('the weekly goal targets the costliest habit', () => {
    expect(weeklyGoal(['FOMO', 'NO_STOP'])).toMatch(/stop-loss on every trade/);
    expect(weeklyGoal([])).toMatch(/Keep your process/);
  });
});
