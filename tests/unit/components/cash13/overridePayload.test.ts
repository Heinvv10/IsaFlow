/**
 * The override editor's PUT body (data layer #1509 storeSchemas.OverrideInput). The person types a positive
 * MAGNITUDE and chooses Money in / Money out (default from `cellSign`: the cell, else the line total, else the
 * first non-zero week, else the category); set/add go out SIGNED by that choice. move_to sends a MAGNITUDE (> 0)
 * or null for the whole cell, with a target Monday other than the cell's week. (The preview: editorBase.test.ts.)
 * A stored override pre-fills the draft (one override per cell: a re-save replaces it).
 */
import { describe, expect, it } from 'vitest';
import { buildOverrideBody, cellSign, draftFromOverride, type OverrideDraft } from '@/components/accounting/cashForecast13/overridePayload';
import type { ForecastLine } from '@/modules/accounting/services/cashForecast13/types';
import { forecastFixture } from './fixture';

const f = forecastFixture({ overrides: [] });
const line = (key: string) => f.lines.find((l) => l.key === key)!;
const W = (cells: Record<number, number>): number[] => Array.from({ length: 13 }, (_, i) => cells[i] ?? 0);
const custom = (category: ForecastLine['category'], cells: Record<number, number>): ForecastLine => {
  const weekly = W(cells);
  return { ...line('sars:emp201'), key: `x:${category}`, category, weekly, totalCents: weekly.reduce((a, b) => a + b, 0) };
};
const draft = (d: Partial<OverrideDraft>): OverrideDraft => ({ mode: 'set', direction: -1, amountCents: null, wholeCell: false, targetWeek: null, note: '', ...d });

describe('cellSign: the default direction, in fallback order', () => {
  it('the cell\'s own sign first: a refund week on a payments line is in', () => {
    expect(cellSign(custom('sars', { 0: 500_00, 1: -900_00 }), 0)).toBe(1);
  });
  it('an empty cell takes the line TOTAL (not the first non-zero week)', () => {
    expect(cellSign(custom('sars', { 0: 100_00, 1: -900_00 }), 5)).toBe(-1);
  });
  it('total 0: the first non-zero week (not the category)', () => {
    expect(cellSign(custom('sars', { 0: 100_00, 1: -100_00 }), 5)).toBe(1);
  });
  it('no figures: the category, receipts in and the rest out', () => {
    expect(cellSign(custom('customer_receipts', {}), 0)).toBe(1);
    expect(cellSign(custom('loans', {}), 0)).toBe(-1);
  });
});

describe('buildOverrideBody', () => {
  const ap = line('ap:s1');
  const wk2 = f.weeks[1]!.start;

  it('Set to, money out: the typed 6 000 goes as -6000 for that Monday', () => {
    expect(buildOverrideBody(draft({ amountCents: 6_000_00, note: ' late ' }), ap, 1, f.weeks))
      .toEqual({ ok: true, body: { lineKey: 'ap:s1', weekStart: wk2, mode: 'set', amount: -6000, note: 'late' } });
  });

  it('reviewer case: a SARS line in net refund, an empty week set to a 20 000 PAYMENT goes negative', () => {
    const sars = custom('sars', { 0: 50_000_00 });
    expect(cellSign(sars, 7)).toBe(1);
    expect(buildOverrideBody(draft({ direction: -1, amountCents: 20_000_00 }), sars, 7, f.weeks)).toMatchObject({ ok: true, body: { amount: -20000 } });
  });

  it('a loans drawdown: money IN on a loans line is positive', () => {
    const loans = line('loan:L1');
    expect(buildOverrideBody(draft({ direction: 1, amountCents: 100_000_00 }), loans, 0, f.weeks)).toMatchObject({ ok: true, body: { amount: 100000 } });
  });

  it('a refund cell set to a payment', () => {
    const sars = custom('sars', { 2: 3_000_00 });
    expect(buildOverrideBody(draft({ direction: -1, amountCents: 5_000_00 }), sars, 2, f.weeks)).toMatchObject({ ok: true, body: { mode: 'set', amount: -5000 } });
  });

  it('set to nothing is 0, never -0', () => {
    const r = buildOverrideBody(draft({ amountCents: 0 }), ap, 1, f.weeks);
    expect(r.ok && Object.is(r.body.amount, 0)).toBe(true);
    expect(r.ok && r.body.note).toBe(null);
  });

  it('add: the direction signs the magnitude; less is the other direction', () => {
    expect(buildOverrideBody(draft({ mode: 'add', direction: -1, amountCents: 1_000_00 }), ap, 1, f.weeks)).toMatchObject({ ok: true, body: { amount: -1000 } });
    expect(buildOverrideBody(draft({ mode: 'add', direction: 1, amountCents: 1_000_00 }), ap, 1, f.weeks)).toMatchObject({ ok: true, body: { amount: 1000 } });
  });

  it('refused before the request: add of 0, a negative typed amount, no amount', () => {
    expect(buildOverrideBody(draft({ mode: 'add', amountCents: 0 }), ap, 1, f.weeks).ok).toBe(false);
    expect(buildOverrideBody(draft({ amountCents: -5_00 }), ap, 1, f.weeks).ok).toBe(false);
    expect(buildOverrideBody(draft({ amountCents: null }), ap, 1, f.weeks).ok).toBe(false);
  });

  it('move_to a part: a positive magnitude and the target Monday', () => {
    expect(buildOverrideBody(draft({ mode: 'move_to', amountCents: 2_000_00, targetWeek: 3 }), ap, 1, f.weeks))
      .toEqual({ ok: true, body: { lineKey: 'ap:s1', weekStart: wk2, mode: 'move_to', amount: 2000, targetWeekStart: f.weeks[3]!.start, note: null } });
  });

  it('move_to the whole cell sends amount null', () => {
    expect(buildOverrideBody(draft({ mode: 'move_to', amountCents: 5_00, wholeCell: true, targetWeek: 4 }), ap, 1, f.weeks))
      .toMatchObject({ ok: true, body: { amount: null, targetWeekStart: f.weeks[4]!.start } });
  });

  it('move_to is refused with no target, the same week, a zero amount, or an empty cell', () => {
    const base = { mode: 'move_to' as const, amountCents: 1_00 };
    expect(buildOverrideBody(draft({ ...base, targetWeek: null }), ap, 1, f.weeks).ok).toBe(false);
    expect(buildOverrideBody(draft({ ...base, targetWeek: 1 }), ap, 1, f.weeks).ok).toBe(false);
    expect(buildOverrideBody(draft({ ...base, amountCents: 0, targetWeek: 2 }), ap, 1, f.weeks).ok).toBe(false);
    expect(buildOverrideBody(draft({ ...base, targetWeek: 2 }), ap, 6, f.weeks).ok).toBe(false);
  });
});

describe('draftFromOverride: a re-save replaces the stored change, so the editor opens on it', () => {
  const ap = line('ap:s1');
  it('set, money out, magnitude, note', () => {
    expect(draftFromOverride({ id: 'o', lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'set', amount: -6000, note: 'agreed' }, ap, 1, f.weeks))
      .toEqual({ mode: 'set', direction: -1, amountCents: 6_000_00, wholeCell: false, targetWeek: null, note: 'agreed' });
  });
  it('add in, on a payments line', () => {
    expect(draftFromOverride({ id: 'o', lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'add', amount: 250.5, note: null }, ap, 1, f.weeks))
      .toMatchObject({ mode: 'add', direction: 1, amountCents: 250_50, note: '' });
  });
  it('move_to the whole week, to week 5', () => {
    expect(draftFromOverride({ id: 'o', lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'move_to', amount: null, targetWeekStart: f.weeks[4]!.start, note: null }, ap, 1, f.weeks))
      .toMatchObject({ mode: 'move_to', wholeCell: true, targetWeek: 4 });
  });
});
