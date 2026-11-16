/**
 * Stored inputs -> engine inputs: cents with payments negative, week indexes from the horizon's first Monday
 * (past and beyond-horizon weeks dropped), overrides kept in the repo's order, null move_to passed through.
 */
import { describe, expect, it } from 'vitest';
import {
  horizonStart, toEngineManualItems, toEngineOverrides, toEnginePayDay, weekOffset,
} from '@/modules/accounting/services/cashForecast13/engineAdapter';
import type { StoredOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';
import type { ManualCashItem } from '@/modules/accounting/services/cashForecast13/storeTypes';

// 2026-11-18 is a Wednesday; its week starts Monday 2026-11-16. Week 12 starts 2027-02-08.
const TODAY = '2026-11-18';
const ov = (o: Partial<StoredOverride>): StoredOverride => ({
  id: 'o1', lineKey: 'payroll:net', weekStart: '2026-11-16', mode: 'set', amount: 100, note: null,
  createdAt: '2026-11-16T08:00:00.000Z', updatedAt: '2026-11-16T08:00:00.000Z', ...o,
});
const item = (o: Partial<ManualCashItem>): ManualCashItem => ({
  id: 'i1', direction: 'receipt', amount: 1234.56, date: '2026-12-01', repeat: 'none', repeatUntil: null,
  description: 'Deposit', category: 'other', ...o,
});

describe('weeks', () => {
  it.each([['2026-11-16', '2026-11-16'], ['2026-11-18', '2026-11-16'], ['2026-11-22', '2026-11-16'], ['2026-11-23', '2026-11-23'], ['2027-01-01', '2026-12-28']])(
    'horizonStart(%s) = %s', (d, m) => { expect(horizonStart(d)).toBe(m); });
  it('weekOffset counts whole weeks, negative into the past, across a DST-free year end', () => {
    expect(weekOffset('2026-11-16', '2026-11-16')).toBe(0);
    expect(weekOffset('2026-11-16', '2027-02-08')).toBe(12);
    expect(weekOffset('2026-11-16', '2026-11-09')).toBe(-1);
    expect(weekOffset('2026-12-28', '2027-01-04')).toBe(1);
  });
});

describe('toEngineManualItems', () => {
  it('a receipt is positive cents, a payment negative; rounding is to the cent', () => {
    const [r, p, f] = toEngineManualItems([item({}), item({ id: 'i2', direction: 'payment', amount: 99.99 }), item({ id: 'i3', amount: 0.29 })]);
    expect(r!.amountCents).toBe(123456);
    expect(p!.amountCents).toBe(-9999);
    expect(f!.amountCents).toBe(29);
  });
  it('a one-off has no repeat; a repeat carries its frequency and end; category and description pass through', () => {
    const [a, b, c] = toEngineManualItems([
      item({}), item({ repeat: 'monthly', repeatUntil: '2027-03-01', category: 'loans' }), item({ repeat: 'weekly' }),
    ]);
    expect(a).toEqual({ id: 'i1', date: '2026-12-01', amountCents: 123456, description: 'Deposit', category: 'other', repeat: null });
    expect(b!.repeat).toEqual({ frequency: 'monthly', until: '2027-03-01' });
    expect(b!.category).toBe('loans');
    expect(c!.repeat).toEqual({ frequency: 'weekly', until: null });
  });
});

describe('toEngineOverrides', () => {
  it('maps week 0 and week 12; drops the week before and week 13', () => {
    const out = toEngineOverrides([
      ov({ id: 'a', weekStart: '2026-11-16' }), ov({ id: 'b', weekStart: '2027-02-08' }),
      ov({ id: 'c', weekStart: '2026-11-09' }), ov({ id: 'd', weekStart: '2027-02-15' }),
    ], TODAY);
    expect(out.map((o) => o.weekIndex)).toEqual([0, 12]);
  });
  it("keeps the input order (the repo's updated_at, id order); never re-sorts by any stamp or id", () => {
    const out = toEngineOverrides([
      ov({ id: 'z', lineKey: 'first', createdAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T07:00:00.000Z' }),
      ov({ id: 'a', lineKey: 'second', createdAt: '2026-11-16T07:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z' }),
      ov({ id: 'm', lineKey: 'third', createdAt: '2026-11-16T08:00:00.000Z', updatedAt: '2026-11-16T08:00:00.000Z' }),
    ], TODAY);
    expect(out.map((o) => o.lineKey)).toEqual(['first', 'second', 'third']);
  });
  it('signed set/add amounts become signed cents', () => {
    const [s, a] = toEngineOverrides([ov({ id: 'a', amount: -80000.5 }), ov({ id: 'b', mode: 'add', amount: 12.34 })], TODAY);
    expect(s).toEqual({ lineKey: 'payroll:net', weekIndex: 0, mode: 'set', amountCents: -8000050 });
    expect(a!.amountCents).toBe(1234);
  });
  it('move_to: target week index; a null amount stays null (the whole cell); a target past the horizon is passed on', () => {
    const [m, n] = toEngineOverrides([
      ov({ id: 'a', mode: 'move_to', amount: null, targetWeekStart: '2026-11-30' }),
      ov({ id: 'b', mode: 'move_to', amount: 500, targetWeekStart: '2027-03-01' }),
    ], TODAY);
    expect(m).toEqual({ lineKey: 'payroll:net', weekIndex: 0, mode: 'move_to', amountCents: null, targetWeek: 2 });
    expect(n).toMatchObject({ amountCents: 50000, targetWeek: 15 });
  });
  it('set/add carry no targetWeek', () => {
    expect(toEngineOverrides([ov({})], TODAY)[0]).not.toHaveProperty('targetWeek');
  });
});

describe('toCents', () => {
  it("is the engine's own (lines.toCents), one implementation", async () => {
    const lines = await import('@/modules/accounting/services/cashForecast13/lines');
    const adapter = await import('@/modules/accounting/services/cashForecast13/engineAdapter');
    expect(adapter.toCents).toBe(lines.toCents);
  });
});

describe('toEnginePayDay', () => {
  it('day N is the number; last working day is the literal', () => {
    expect(toEnginePayDay({ kind: 'day_of_month', day: 31 })).toBe(31);
    expect(toEnginePayDay({ kind: 'last_working_day' })).toBe('last_working_day');
  });
});
