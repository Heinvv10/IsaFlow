import { describe, it, expect } from 'vitest';
import {
  applyTrend, applyBudgetComparator,
} from '@/modules/accounting/services/reports/statementRows/comparators';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';

const MONTHS = ['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];

const ROWS: StatementRow[] = [
  { id: 'sec:revenue', kind: 'section', label: 'Turnover', depth: 0, actual: 900_000 },
  { id: 'acc:1000', kind: 'line', label: 'Sales', depth: 1, accountCode: '1000', actual: 900_000 },
  { id: 'acc:6000', kind: 'line', label: 'Rent', depth: 1, accountCode: '6000', actual: 130_000 },
  { id: 'sub:revenue', kind: 'subtotal', label: 'Total Turnover', depth: 0, actual: 900_000 },
];

describe('applyTrend', () => {
  const trends = { months: MONTHS, byAccountCode: { '1000': MONTHS.map((_, i) => i * 1000) }, unavailable: {} };

  it('attaches the twelve figures to the row with that account code', () => {
    const out = applyTrend(ROWS, trends);
    expect(out[1]!.trend).toEqual(trends.byAccountCode['1000']);
  });

  it('leaves a row with no trend data undefined rather than inventing zeros', () => {
    const out = applyTrend(ROWS, trends);
    expect(out[2]!.trend).toBeUndefined();
  });

  it('never puts a trend on a section, subtotal or total row', () => {
    const out = applyTrend(ROWS, { months: MONTHS, byAccountCode: { '1000': MONTHS.map(() => 1) }, unavailable: {} });
    expect(out[0]!.trend).toBeUndefined();
    expect(out[3]!.trend).toBeUndefined();
  });

  it('does not mutate the rows it was given', () => {
    applyTrend(ROWS, trends);
    expect(ROWS[1]!.trend).toBeUndefined();
  });

  it('leaves trend undefined for an account the service flags unavailable, never twelve zeros', () => {
    const withUnavailable = {
      months: MONTHS,
      byAccountCode: { '1000': MONTHS.map((_, i) => i * 1000) },
      unavailable: { '6000': 'derived balance, not posted' },
    };
    const rowsWithRetainedEarnings: StatementRow[] = [
      ...ROWS,
      { id: 'acc:6000-re', kind: 'line', label: 'Retained Earnings', depth: 1, accountCode: '6000', actual: 50_000 },
    ];
    const out = applyTrend(rowsWithRetainedEarnings, withUnavailable);
    expect(out[4]!.trend).toBeUndefined();
  });
});

describe('applyBudgetComparator', () => {
  const lines = buildBudgetVsActualLines(
    [
      { id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900_000 },
      { id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 130_000 },
    ],
    { '1000': 1_000_000, '6000': 120_000 },
  );

  it('copies the budget figure onto the row', () => {
    const out = applyBudgetComparator(ROWS, lines);
    expect(out[1]!.budget?.value).toBe(1_000_000);
    expect(out[2]!.budget?.value).toBe(120_000);
  });

  it('reports the MOVEMENT, actual minus budget, like every other comparator', () => {
    const out = applyBudgetComparator(ROWS, lines);
    expect(out[1]!.budget?.variance).toBe(-100_000); // 900k actual vs 1.0m budget
    expect(out[2]!.budget?.variance).toBe(10_000);   // 130k actual vs 120k budget
  });

  it('takes polarity from the service, so an overspent expense is unfavourable even though its movement is positive', () => {
    const out = applyBudgetComparator(ROWS, lines);
    expect(out[1]!.budget?.favourable).toBe(false); // revenue under budget
    expect(out[2]!.budget?.favourable).toBe(false); // expense over budget
  });

  it('marks a favourable line favourable', () => {
    const good = buildBudgetVsActualLines(
      [{ id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 110_000 }],
      { '6000': 120_000 },
    );
    const out = applyBudgetComparator(ROWS, good);
    expect(out[2]!.budget?.favourable).toBe(true);
    expect(out[2]!.budget?.variance).toBe(-10_000);
  });

  it('copies the service percentage rather than recomputing one', () => {
    const out = applyBudgetComparator(ROWS, lines);
    expect(out[1]!.budget?.variancePct).toBe(lines.find((l) => l.account_code === '1000')!.variance_pct);
  });

  it('leaves an unbudgeted row without a budget comparison', () => {
    const out = applyBudgetComparator(ROWS, lines.filter((l) => l.account_code === '1000'));
    expect(out[2]!.budget).toBeUndefined();
  });

  it('does not mutate the rows it was given', () => {
    applyBudgetComparator(ROWS, lines);
    expect(ROWS[1]!.budget).toBeUndefined();
  });
});
