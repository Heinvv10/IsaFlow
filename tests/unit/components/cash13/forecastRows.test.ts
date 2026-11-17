/**
 * The grid's groups over the engine's lines: receipts, supplier payments, payroll, SARS, loans, recurring, budget
 * estimate, manual items, overrides (and "other"), each with a subtotal that sums its lines; every line in exactly
 * one group; the groups' subtotals add up to the engine's net per week.
 */
import { describe, expect, it } from 'vitest';
import { groupLines, weekLabel, groupOf } from '@/components/accounting/cashForecast13/forecastRows';
import { forecastFixture } from './fixture';

const f = forecastFixture();

describe('groupLines', () => {
  const groups = groupLines(f.lines);
  const ids = groups.map((g) => g.id);

  it('orders the groups and leaves out empty ones', () => {
    expect(ids).toEqual(['receipts', 'supplier_payments', 'payroll', 'sars', 'loans', 'recurring', 'budget', 'manual', 'overrides']);
  });

  it('puts each line in its group', () => {
    const where = (key: string) => groups.find((g) => g.lines.some((l) => l.key === key))?.id;
    expect(where('ar:c1')).toBe('receipts');
    expect(where('recurring:r1')).toBe('recurring');
    expect(where('budget:customer_receipts')).toBe('budget');
    expect(where(`manual:${'11111111-1111-4111-8111-111111111111'}`)).toBe('manual');
    expect(where('override:ap:s1')).toBe('overrides');
    expect(where('sars:emp201')).toBe('sars');
  });

  it('every line once; subtotals sum the lines; all groups sum to the net', () => {
    expect(groups.flatMap((g) => g.lines).length).toBe(f.lines.length);
    for (const g of groups) {
      g.subtotal.forEach((v, w) => expect(v).toBe(g.lines.reduce((s, l) => s + (l.weekly[w] ?? 0), 0)));
      expect(g.total).toBe(g.subtotal.reduce((a, b) => a + b, 0));
    }
    f.weeks.forEach((wk, w) => expect(groups.reduce((s, g) => s + (g.subtotal[w] ?? 0), 0)).toBe(wk.netCents));
  });

  it('a non-budget estimate (EMP201 from the latest run) stays in its own category', () => {
    expect(groupOf(f.lines.find((l) => l.key === 'sars:emp201')!)).toBe('sars');
  });
});

describe('weekLabel', () => {
  it('reads "Week 1 · 16 Nov"', () => {
    expect(weekLabel(f.weeks[0]!)).toBe('Week 1 · 16 Nov');
    expect(weekLabel(f.weeks[12]!)).toBe('Week 13 · 8 Feb');
  });
});
