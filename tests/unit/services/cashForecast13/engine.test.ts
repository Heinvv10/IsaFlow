import { describe, it, expect } from 'vitest';
import { runEngine } from '@/modules/accounting/services/cashForecast13/engine';
import { buildWeeks, weekIndexOf } from '@/modules/accounting/services/cashForecast13/weeks';
import type { EngineInput, KnownItem } from '@/modules/accounting/services/cashForecast13/types';

const NO_OVERDUE = { totalCents: 0, beyondHorizonCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 };

function input(over: Partial<EngineInput> = {}): EngineInput {
  return { today: '2026-11-18', openingCents: 100_000, items: [], budget: null, manualItems: [], overrides: [], overdueAR: NO_OVERDUE, warnings: [], ...over };
}

function item(date: string, amountCents: number, over: Partial<KnownItem> = {}): KnownItem {
  return { lineKey: 'ar:c1:due', lineLabel: 'Cust 1', category: 'customer_receipts', date, amountCents, ref: `inv-${date}-${amountCents}`, refLabel: 'INV', ...over };
}

/** opening + Σ lines = closing per week, and the next opening is this closing. */
function assertInvariants(out: ReturnType<typeof runEngine>, opening: number) {
  expect(out.weeks).toHaveLength(13);
  let prev = opening;
  out.weeks.forEach((w, i) => {
    expect(w.openingCents).toBe(prev);
    const sum = out.lines.reduce((t, l) => t + (l.weekly[i] as number), 0);
    expect(w.netCents).toBe(sum);
    expect(w.inflowsCents + w.outflowsCents).toBe(sum);
    expect(w.closingCents).toBe(w.openingCents + sum);
    prev = w.closingCents;
  });
  for (const l of out.lines) {
    expect(l.weekly).toHaveLength(13);
    expect(l.totalCents).toBe(l.weekly.reduce((a, b) => a + b, 0));
    for (const v of l.weekly) expect(Number.isSafeInteger(v)).toBe(true);
  }
}

describe('cash13 weeks', () => {
  it('week 1 is the Monday-to-Sunday week holding today', () => {
    expect(buildWeeks('2026-11-18')[0]).toEqual({ index: 0, start: '2026-11-16', end: '2026-11-22' });
    // Monday and Sunday edges.
    expect(buildWeeks('2026-11-16')[0]?.start).toBe('2026-11-16');
    expect(buildWeeks('2026-11-22')[0]).toEqual({ index: 0, start: '2026-11-16', end: '2026-11-22' });
    const w = buildWeeks('2026-11-18');
    expect(w[12]).toEqual({ index: 12, start: '2027-02-08', end: '2027-02-14' });
  });

  it('buckets Sunday into its own week and Monday into the next, across a month and year end', () => {
    const today = '2026-12-30';
    const w = buildWeeks(today); // week 1 = 2026-12-28..2027-01-03
    expect(weekIndexOf('2027-01-03', today, w)).toBe(0);
    expect(weekIndexOf('2027-01-04', today, w)).toBe(1);
    expect(weekIndexOf('2026-11-01', today, w)).toBe(0); // the past lands in week 1
    expect(weekIndexOf(w[12]!.end, today, w)).toBe(12);
    expect(weekIndexOf('2027-12-31', today, w)).toBeNull();
  });
});

describe('cash13 engine', () => {
  it('rolls opening + lines into closing week by week', () => {
    const out = runEngine(input({ items: [item('2026-11-20', 5_000), item('2026-11-30', -2_000, { lineKey: 'ap:s1', category: 'supplier_payments' })] }));
    assertInvariants(out, 100_000);
    expect(out.weeks[0]?.closingCents).toBe(105_000);
    expect(out.weeks[2]?.closingCents).toBe(103_000);
    expect(out.weeks[0]?.inflowsCents).toBe(5_000);
    expect(out.weeks[2]?.outflowsCents).toBe(-2_000);
    expect(out.weeks[12]?.closingCents).toBe(103_000);
  });

  it('puts an overdue item in week 1 and drops an item past the horizon with a count warning', () => {
    const out = runEngine(input({ items: [item('2026-10-01', 700), item('2027-06-01', 900)] }));
    const line = out.lines.find((l) => l.key === 'ar:c1:due')!;
    expect(line.weekly[0]).toBe(700);
    expect(line.totalCents).toBe(700);
    expect(line.items.map((i) => i.date)).toEqual(['2026-10-01']);
    expect(out.warnings.some((w) => w.code === 'beyond_horizon')).toBe(true);
    assertInvariants(out, 100_000);
  });

  it('carries an AR line basis and kind known; an estimate item makes its line an estimate', () => {
    const out = runEngine(input({ items: [
      item('2026-11-20', 100, { lineKey: 'ar:c1:history', basis: 'history' }),
      item('2026-11-20', -50, { lineKey: 'sars:emp201', category: 'sars', estimate: true }),
    ] }));
    expect(out.lines.find((l) => l.key === 'ar:c1:history')).toMatchObject({ kind: 'known', basis: 'history' });
    expect(out.lines.find((l) => l.key === 'sars:emp201')).toMatchObject({ kind: 'estimate' });
  });

  it('is deterministic: item order does not change the output', () => {
    const items = [item('2026-11-20', 1, { lineKey: 'b' }), item('2026-12-20', 2, { lineKey: 'a' }), item('2026-11-21', 3, { lineKey: 'a', ref: 'x' })];
    const a = runEngine(input({ items }));
    const b = runEngine(input({ items: [...items].reverse() }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('refuses a non-integer amount (cents only)', () => {
    expect(() => runEngine(input({ items: [item('2026-11-20', 1.5)] }))).toThrow(/integer cents/);
    expect(() => runEngine(input({ openingCents: 0.1 }))).toThrow(/integer cents/);
  });

  it('passes reader warnings and the overdue summary through', () => {
    const overdueAR = { totalCents: 5, beyondHorizonCents: 0, invoiceCount: 1, byBasis: { history: 0, no_history: 5 }, disputedCents: 2 };
    const out = runEngine(input({ overdueAR, warnings: [{ code: 'source_unavailable', source: 'loans', message: 'x' }] }));
    expect(out.overdueAR).toEqual(overdueAR);
    expect(out.warnings[0]).toMatchObject({ code: 'source_unavailable', source: 'loans' });
  });
});
