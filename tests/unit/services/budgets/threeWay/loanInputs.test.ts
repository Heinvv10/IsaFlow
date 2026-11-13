/**
 * P6 PR C: loan schedule lines for the engine (spec §5 `loanSchedules`): the
 * pure month fold of amortisation rows, and a planned loan's schedule through
 * `amortise` (first instalment in `firstRepaymentMonth`).
 */
import { describe, expect, it } from 'vitest';
import { amortise } from '@/lib/amortisation/engine';
import type { ScheduleRow } from '@/lib/amortisation/types';
import { plannedLoanInputs, scheduleLines } from '@/modules/accounting/services/budgets/threeWay/loanInputs';

const row = (date: string, principal: number, interest: number, lump = 0): ScheduleRow => ({
  period: 1, date, opening: 0, rate: 0, installment: 0, interest, principal, intPortion: interest, skip: false,
  payment: principal + interest, lump, closing: 0, stLiability: 0, extrapolated: false, nca_flagged: false,
});

describe('scheduleLines', () => {
  it('cents per month inside the version only; a lump is principal repaid', () => {
    expect(scheduleLines([
      row('2026-02-01', 100, 10),
      row('2026-03-01', 1000.25, 50.5),
      row('2026-04-01', 1000, 40, 500),
      row('2027-03-01', 1, 1),
    ], ['2026-03', '2026-04'])).toEqual([
      { month: '2026-03', principal: 100025, interest: 5050 },
      { month: '2026-04', principal: 150000, interest: 4000 },
    ]);
  });
});

describe('a planned loan', () => {
  it('repays from firstRepaymentMonth, level instalments, the whole principal over the term', () => {
    const planned = { id: 'p1', description: 'Bakkie', drawdownMonth: '2026-04', principal: 12_000_000, annualRatePct: 12, termMonths: 12, firstRepaymentMonth: '2026-05' };
    const rows = amortise(plannedLoanInputs(planned), [], []);
    expect(rows[0]!.date.slice(0, 7)).toBe('2026-05');
    expect(rows).toHaveLength(12);
    const months = Array.from({ length: 13 }, (_, i) => `${2026 + Math.floor((3 + i) / 12)}-${String(((3 + i) % 12) + 1).padStart(2, '0')}`);
    const lines = scheduleLines(rows, months);
    expect(lines[0]!.month).toBe('2026-05');
    expect(lines.reduce((s, l) => s + l.principal, 0)).toBe(12_000_000);
    expect(lines[0]!.interest).toBe(120_000);
  });
});
