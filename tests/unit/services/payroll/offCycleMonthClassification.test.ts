/**
 * Wave 6 OC: an off-cycle line's PAYE employment class (G21 p. 28), split out of offCycleMonthLine.test.ts (review L5 of
 * f37f0f15a6). The bonus is classified on the month's recurring time-worked pay, the regular line's included; a
 * historical regular line that cannot be rebuilt gives its stored class.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));

import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { MonthEarlierLines } from '@/modules/accounting/services/payroll/payrollOffCycleMonth';
import { earningsOfBreakdown } from '@/modules/accounting/services/payroll/payrollOffCycleMonthRead';
import type { EmployeeComponent } from '@/modules/accounting/services/payroll/payrollTypes';
import { bonusLine, earlierFrom, earning, employee, period, regularLine } from './offCycleMonthLine.helpers';

// Gate ruling 2 on 7630d9379f: the bonus line is classified (G21 p. 28) on the month's time-worked earnings, the
// regular line's included, as the regular line was: a bonus alone has none, so the recorded day rate would decide.
describe('PAYE classification of an off-cycle bonus (review #1679 gate ruling 2)', () => {
  // 20 hours a week, 8 a day, R300 a day recorded; overtime took the month's earnings to R450 a day (R4 875 over
  // 20 / 8 × 52 / 12 days): non-standard on the regular line (at least the 2027 threshold a day).
  const partTime = employee({ hoursPerWeek: 20, hoursPerDay: 8, dailyRate: 300, payBasis: 'daily' });
  const regular = regularLine(4_875, partTime);
  const treatmentOf = (l: ReturnType<typeof regularLine>) => l.explanations.paye.steps.find((s) => s.key === 'paye.treatment')?.label;
  it('the regular line is non-standard (flat rate), and the bonus beside it is too', () => {
    expect(treatmentOf(regular)).toMatch(/Non-standard employment/);
    const bonus = bonusLine(10_000, earlierFrom(regular, 4_875), undefined, partTime);
    expect(treatmentOf(bonus)).toMatch(/Non-standard employment/);
  });
});

describe('the employment class across the month (G21 p. 28 day pay; review #1679 Codex of 7630d9379)', () => {
  // 14 hours a week in days of 6 at R300 a day: deemed standard (tables) on the rate alone. 3 033 + 1 517 = R4 550 for
  // the month's 10.11 scheduled days is R450 a day, over R394: the regular line is non-standard (flat 25%).
  const partTime = employee({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 300 });
  const month = [earning('basic', '3601', 3_033), earning('overtime', '3607', 1_517)];
  const earlier: MonthEarlierLines = { uifRemuneration: 4_550, eti: 0, etiComponents: month };
  it('the bonus is classified on the regular line\'s basic pay and overtime, as the regular line was', () => {
    const regular = calculatePayrollLine({ employee: partTime, components: month, period, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(regular.paye.monthlyPaye).toBeCloseTo(4_550 * 0.25, 2);
    const bonus = bonusLine(10_000, earlier, undefined, partTime);
    expect(bonus.paye.monthlyPaye).toBeCloseTo(2_500, 2);
  });
  it('with no time worked over the rate in the month, the rate decides (tables)', () => {
    const basicOnly: MonthEarlierLines = { uifRemuneration: 3_033, eti: 0, etiComponents: [earning('basic', '3601', 3_033)] };
    expect(bonusLine(10_000, basicOnly, undefined, partTime).paye.monthlyPaye).not.toBeCloseTo(2_500, 2);
  });
});

// Review follow-up on ed7bdab53e: only the regular line's RECURRING time-worked pay classifies the bonus, as on the
// regular line itself (timeWorkedEarnings): a once-off 3601 there is recorded on its breakdown item (onceOff) and
// left out when the earlier lines are rebuilt.
describe('the employment class across the month: a once-off basic pay item does not count (review of ed7bdab53e)', () => {
  const partTime = employee({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 300 });
  it('a once-off 3601 on the regular line is flagged on its breakdown, and the rebuild leaves it out', () => {
    const onceOff: EmployeeComponent = { ...earning('extra', '3601', 1_517), isRecurring: false };
    const regular = calculatePayrollLine({ employee: partTime, components: [earning('basic', '3601', 3_033), onceOff], period, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(regular.componentBreakdown.find((i) => i.componentId === 'extra')).toMatchObject({ onceOff: true });
    expect(regular.componentBreakdown.find((i) => i.componentId === 'basic')?.onceOff).toBeUndefined();
    const rebuilt = earningsOfBreakdown(regular.componentBreakdown.map((i) => ({ ...i, isEarning: true })));
    expect(rebuilt.find((c) => c.component.id === 'extra')?.isRecurring).toBe(false);
    // R3 033 recurring over 10.11 days is R300 a day: deemed standard (tables), as the regular line was.
    const bonus = bonusLine(10_000, { uifRemuneration: 4_550, eti: 0, etiComponents: rebuilt }, undefined, partTime);
    expect(bonus.paye.monthlyPaye).not.toBeCloseTo(2_500, 2);
  });
});

// Gate ruling 1 on e0eec1dea1: a regular line costed before the onceOff marker whose once-off pay cannot be told from
// its recurring pay (payrollOffCycleMonthRead: storedClass) is not reclassified: the bonus takes that line's class.
describe('a historical regular line that cannot be rebuilt: its stored class (review of e0eec1dea1)', () => {
  const partTime = employee({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 300 });
  const treatmentOf = (l: ReturnType<typeof regularLine>) => l.explanations.paye.steps.find((s) => s.key === 'paye.treatment')?.label;
  it('stored on the tables: the bonus is on the tables, whatever the rebuilt earnings say', () => {
    const month = [earning('basic', '3601', 3_033), earning('overtime', '3607', 1_517)]; // R450 a day if all counted
    const bonus = bonusLine(10_000, { uifRemuneration: 4_550, eti: 0, etiComponents: month, storedClass: 'tables' }, undefined, partTime);
    expect(treatmentOf(bonus)).toMatch(/Taxed on the SARS tables/);
  });
  it('stored as flat: the bonus is non-standard too', () => {
    const bonus = bonusLine(10_000, { uifRemuneration: 3_033, eti: 0, etiComponents: [earning('basic', '3601', 3_033)], storedClass: 'flat' }, undefined, partTime);
    expect(treatmentOf(bonus)).toMatch(/Non-standard employment/);
  });
});
