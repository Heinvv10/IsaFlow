/**
 * The override editor's PUT body (data layer #1509 storeSchemas.OverrideInput): set/add amounts are SIGNED in the
 * cell's own sign (a payment is negative), the person types what they see; move_to sends a MAGNITUDE (> 0) or
 * null for the whole cell, with a target Monday other than the cell's week.
 */
import { describe, expect, it } from 'vitest';
import { buildOverrideBody, cellSign } from '@/components/accounting/cashForecast13/overridePayload';
import { forecastFixture } from './fixture';

const f = forecastFixture({ overrides: [] });
const line = (key: string) => f.lines.find((l) => l.key === key)!;

describe('cellSign', () => {
  it('a payment cell is negative, a receipt cell positive', () => {
    expect(cellSign(line('ap:s1'), 1)).toBe(-1);
    expect(cellSign(line('ar:c1:due'), 0)).toBe(1);
  });
  it('an empty cell takes the line\'s sign', () => {
    expect(cellSign(line('payroll:net'), 5)).toBe(-1);
    expect(cellSign(line('ar:c1:due'), 7)).toBe(1);
  });
  it('a line with no figures falls back on its category: receipts in, the rest out', () => {
    const empty = { ...line('ar:c1:due'), weekly: Array(13).fill(0), totalCents: 0 };
    expect(cellSign(empty, 0)).toBe(1);
    expect(cellSign({ ...empty, category: 'sars' }, 0)).toBe(-1);
  });
  it('a refund cell on a payments line keeps its own sign', () => {
    const mixed = { ...line('sars:emp201'), weekly: [500_00, ...Array(12).fill(-100_00)], totalCents: -700_00 };
    expect(cellSign(mixed, 0)).toBe(1);
  });
});

describe('buildOverrideBody', () => {
  const ap = line('ap:s1');
  it('set on a payment cell sends the typed amount negative, in rand', () => {
    expect(buildOverrideBody({ mode: 'set', amountCents: 6_000_00, wholeCell: false, targetWeek: null, note: ' late ' }, ap, 1, f.weeks))
      .toEqual({ ok: true, body: { lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'set', amount: -6000, note: 'late' } });
  });
  it('set to nothing on a payment cell is 0, never -0', () => {
    const r = buildOverrideBody({ mode: 'set', amountCents: 0, wholeCell: false, targetWeek: null, note: '' }, ap, 1, f.weeks);
    expect(r.ok && Object.is(r.body.amount, 0)).toBe(true);
    expect(r.ok && r.body.note).toBe(null);
  });
  it('add on a receipt cell is positive; a negative add (less) stays negative', () => {
    const ar = line('ar:c1:due');
    expect(buildOverrideBody({ mode: 'add', amountCents: 150_50, wholeCell: false, targetWeek: null, note: '' }, ar, 0, f.weeks))
      .toMatchObject({ ok: true, body: { mode: 'add', amount: 150.5 } });
    expect(buildOverrideBody({ mode: 'add', amountCents: -100_00, wholeCell: false, targetWeek: null, note: '' }, ar, 0, f.weeks))
      .toMatchObject({ ok: true, body: { amount: -100 } });
  });
  it('add on a payment cell flips the typed sign: "add R1 000" pays R1 000 more', () => {
    expect(buildOverrideBody({ mode: 'add', amountCents: 1_000_00, wholeCell: false, targetWeek: null, note: '' }, ap, 1, f.weeks))
      .toMatchObject({ ok: true, body: { amount: -1000 } });
  });
  it('add of nothing is refused before the request', () => {
    expect(buildOverrideBody({ mode: 'add', amountCents: 0, wholeCell: false, targetWeek: null, note: '' }, ap, 1, f.weeks).ok).toBe(false);
  });
  it('move_to a part sends a positive magnitude and the target Monday, whatever the cell sign', () => {
    expect(buildOverrideBody({ mode: 'move_to', amountCents: 2_000_00, wholeCell: false, targetWeek: 3, note: '' }, ap, 1, f.weeks))
      .toEqual({ ok: true, body: { lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'move_to', amount: 2000, targetWeekStart: f.weeks[3]!.start, note: null } });
  });
  it('move_to the whole cell sends amount null', () => {
    expect(buildOverrideBody({ mode: 'move_to', amountCents: 5_00, wholeCell: true, targetWeek: 4, note: '' }, ap, 1, f.weeks))
      .toMatchObject({ ok: true, body: { amount: null, targetWeekStart: f.weeks[4]!.start } });
  });
  it('move_to is refused with no target, the same week, a zero amount, or an empty cell', () => {
    const base = { mode: 'move_to' as const, amountCents: 1_00, wholeCell: false, note: '' };
    expect(buildOverrideBody({ ...base, targetWeek: null }, ap, 1, f.weeks).ok).toBe(false);
    expect(buildOverrideBody({ ...base, targetWeek: 1 }, ap, 1, f.weeks).ok).toBe(false);
    expect(buildOverrideBody({ ...base, amountCents: 0, targetWeek: 2 }, ap, 1, f.weeks).ok).toBe(false);
    expect(buildOverrideBody({ ...base, targetWeek: 2 }, ap, 6, f.weeks).ok).toBe(false);
  });
  it('set and add need an amount', () => {
    expect(buildOverrideBody({ mode: 'set', amountCents: null, wholeCell: false, targetWeek: null, note: '' }, ap, 1, f.weeks).ok).toBe(false);
  });
});
