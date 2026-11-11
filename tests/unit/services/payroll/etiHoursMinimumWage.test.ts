/**
 * ETI by hours and the minimum wage (master plan wave 5, ET).
 * Sources: ETI Act s7(5) and s4(1)(a); SARS Guide to the Employment Tax Incentive, Issue 5 (27 July 2026), §2.4.1 p. 18,
 * §2.7 pp. 20-21, §4.1 pp. 29-31, §5.3 pp. 40-41 (Examples 15, 16); National Minimum Wage Act 9 of 2018 s5(1) and
 * Schedule 1 (R28.79 from 1 March 2025; R30.23 from 1 March 2026, GN R. 7083, GG 54075).
 */
import { describe, expect, it } from 'vitest';
import { calculateEti } from '@/modules/accounting/services/payroll/etiEngine';
import { nationalMinimumWageCents } from '@/modules/accounting/services/payroll/etiTables';
import {
  belowMinimumWage, etiHoursOf, ordinaryWageCents,
} from '@/modules/accounting/services/payroll/etiHours';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const JUNE_2025 = new Date(2025, 5, 28);

/** Aged 24, employed since 1 March 2025 (month 4: year 1), the O2 fixtures' employee. */
function eti(remuneration: number, hours: number | null, ordinaryWage = remuneration, periodDate = JUNE_2025) {
  return calculateEti({
    dateOfBirth: new Date(2001, 0, 1),
    employmentStartDate: new Date(2025, 2, 1),
    periodDate,
    monthlyRemuneration: remuneration,
    isUifExcluded: false,
    hours: hours == null ? null : { monthlyHours: hours, ordinaryWageCents: Math.round(ordinaryWage * 100) },
  }, 2026);
}

describe('s7(5): gross up to 160 hours, apply the table, gross down by hours / 160', () => {
  it('R5 000 for 120 h in year 1 -> R468.75 (6 666.67 is in the taper: 625.00 x 120/160)', () => {
    expect(eti(5_000, 120).monthlyEti).toBe(468.75);
  });
  it('guide Example 15: R2 100 for 70 h -> R656.25; Example 16: R2 250 for 90 h -> R843.75', () => {
    // Both examples are for an NMW-exempt employer; R30 and R25 an hour. Example 16 is below the NMW, so it is
    // checked here with an ordinary wage that passes, to pin only the apportionment.
    expect(eti(2_100, 70).monthlyEti).toBe(656.25);
    expect(eti(2_250, 90, 9_000).monthlyEti).toBe(843.75);
  });
  it('160 hours or more: the table value unchanged', () => {
    expect(eti(6_000, 160).monthlyEti).toBe(1_125);
    expect(eti(6_000, 200).monthlyEti).toBe(1_125);
    expect(eti(5_000, 160).monthlyEti).toBe(1_500);
  });
  it('the wage ceiling is judged on the grossed-up remuneration: R6 000 for 120 h grosses to R8 000, nil', () => {
    const r = eti(6_000, 120);
    expect(r.monthlyEti).toBe(0);
    expect(r.isEligible).toBe(false);
  });
  it('no hours employed: nil, determined', () => {
    const r = eti(0, 0);
    expect(r).toMatchObject({ isEligible: false, isDeterminable: true, monthlyEti: 0 });
  });
  it('hours unknown: the figure is today\'s (no apportionment, no minimum-wage test)', () => {
    expect(eti(5_000, null).monthlyEti).toBe(1_500);
    expect(eti(4_000, null).monthlyEti).toBe(1_500);
  });
});

describe('s4(1)(a): the wage for ordinary hours against the national minimum, in cents', () => {
  it('exactly R28.79 x 160 = R4 606.40 qualifies; 1c below is nil', () => {
    expect(eti(4_606.40, 160).monthlyEti).toBe(1_500);
    const below = eti(4_606.39, 160);
    expect(below.monthlyEti).toBe(0);
    expect(below.isEligible).toBe(false);
    expect(below.ineligibilityReason).toMatch(/minimum wage/i);
  });
  it('R4 000 for 160 h (R25 an hour) is below the minimum: nil', () => {
    expect(eti(4_000, 160).monthlyEti).toBe(0);
  });
  it('a bonus does not lift an underpaid employee over the minimum: the ordinary wage is tested, not the remuneration', () => {
    // R4 000 basic + R2 000 bonus: remuneration R6 000, ordinary wage R4 000 for 160 h.
    expect(eti(6_000, 160, 4_000).monthlyEti).toBe(0);
  });
  it('the minimum is by pay period: R30.23 from 1 March 2026', () => {
    expect(nationalMinimumWageCents(new Date(2026, 1, 28))).toBe(2879);
    expect(nationalMinimumWageCents(new Date(2026, 2, 28))).toBe(3023);
    expect(nationalMinimumWageCents(new Date(2025, 1, 28))).toBeNull();
    const march2026 = new Date(2026, 2, 28);
    // R4 836.80 = 160 x R30.23 qualifies in March 2026 (month 13: the second-year R750); R4 836.79 does not.
    expect(eti(4_836.80, 160, 4_836.80, march2026).monthlyEti).toBe(750);
    expect(eti(4_836.79, 160, 4_836.79, march2026).monthlyEti).toBe(0);
  });
  it('compares exact integers, not float rand', () => {
    expect(belowMinimumWage(460_640, 160, 2879)).toBe(false);
    expect(belowMinimumWage(460_639, 160, 2879)).toBe(true);
    // 86.67 h x R28.79 = R2 495.2293: R2 495.23 is not below, R2 495.22 is.
    expect(belowMinimumWage(249_523, 86.67, 2879)).toBe(false);
    expect(belowMinimumWage(249_522, 86.67, 2879)).toBe(true);
  });
});

const comp = (code: string, amount: number, extra: Partial<EmployeeComponent> = {}): EmployeeComponent => ({
  component: { id: code, name: code, sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true },
  amount, ...extra,
});

describe('the ordinary wage (NMW Act s5(1); guide §2.7)', () => {
  it('cash basic pay only: no overtime, bonus, allowance or non-cash benefit', () => {
    expect(ordinaryWageCents([
      comp('3601', 4_000), comp(' 3601 ', 100.5), comp('3607', 600), comp('3605', 2_000), comp('3701', 500),
      comp('3601', 300, { isNonCash: true }),
    ])).toBe(410_050);
  });
});

describe('hours employed in the month', () => {
  const base: Pick<PayrollEmployee, 'payBasis' | 'hoursPerWeek' | 'startDate' | 'endDate'> = {
    payBasis: 'monthly', hoursPerWeek: 40, startDate: new Date(2024, 0, 1),
  };
  const june = { year: 2025, month: 6 };
  it('monthly: hours a week x 52 / 12; unknown is null, never a full month', () => {
    expect(etiHoursOf(base, june, null)).toBe(173.33);
    expect(etiHoursOf({ ...base, hoursPerWeek: 20 }, june, null)).toBe(86.67);
    expect(etiHoursOf({ ...base, hoursPerWeek: null }, june, null)).toBeNull();
    expect(etiHoursOf({ ...base, hoursPerWeek: 0 }, june, null)).toBeNull();
  });
  it('monthly starter: only the share of the month employed (June 2025 has 21 weekdays; from the 16th, 11)', () => {
    expect(etiHoursOf({ ...base, startDate: new Date(2025, 5, 16) }, june, null)).toBe(90.79);
  });
  it('hourly or daily: the run\'s hours, whatever the hours a week', () => {
    expect(etiHoursOf({ ...base, payBasis: 'hourly' }, june, 120)).toBe(120);
    expect(etiHoursOf({ ...base, payBasis: 'daily' }, june, null)).toBeNull();
  });
});

describe('the calculator tests the ordinary wage, not the month\'s remuneration', () => {
  it('160 h at R25 (R4 000 basic) plus a R2 000 bonus: below R30.23 an hour, so nil although R6 000 would pass', async () => {
    const { calculatePayrollLine } = await import('@/modules/accounting/services/payroll/payrollCalculator');
    const employee: PayrollEmployee = {
      id: 'e1', companyId: 'co', employeeNumber: 'E1', firstName: 'Test', lastName: 'Employee', employmentType: 'permanent',
      startDate: new Date(2026, 0, 1), dateOfBirth: new Date(2004, 5, 1), uifExcluded: false, medicalAidMainMember: false,
      medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'hourly', hourlyRate: 25,
    };
    const line = calculatePayrollLine({
      employee,
      components: [comp('3601', 4_000, { quantity: 160, quantityUnit: 'hour' }), comp('3605', 2_000)],
      period: { month: 11, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 'defer',
    });
    expect(line.eti.monthlyEti).toBe(0);
    expect(line.eti.ineligibilityReason).toMatch(/national minimum wage of R30\.23/);
  });
});

describe('non-cash payments are not ETI "monthly remuneration" (guide Issue 5 §2.4.1 p. 18, from 1 March 2022)', () => {
  const run = async (components: EmployeeComponent[]) => {
    const { calculatePayrollLine } = await import('@/modules/accounting/services/payroll/payrollCalculator');
    return calculatePayrollLine({
      employee: {
        id: 'e1', companyId: 'co', employeeNumber: 'E1', firstName: 'Test', lastName: 'Employee', employmentType: 'permanent',
        startDate: new Date(2026, 0, 1), dateOfBirth: new Date(2004, 5, 1), uifExcluded: false, medicalAidMainMember: false,
        medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: null,
      },
      components, period: { month: 6, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 'defer',
    });
  };
  it('R4 000 cash plus a R2 000 loan benefit (3801, non-cash): ETI on R4 000 = R1 500, not on R6 000 (R1 125)', async () => {
    const line = await run([comp('3601', 4_000), comp('3801', 2_000, { isNonCash: true })]);
    expect(line.eti.monthlyEti).toBe(1_500);
  });
  it('a 38xx benefit set up without the non-cash flag (3802 vehicle, 3810 medical) is left out too', async () => {
    expect((await run([comp('3601', 4_000), comp('3802', 1_500), comp('3810', 500)])).eti.monthlyEti).toBe(1_500);
  });
  it('a cash allowance stays in: R4 000 + R2 000 allowance (3713) = R6 000, R1 125', async () => {
    expect((await run([comp('3601', 4_000), comp('3713', 2_000)])).eti.monthlyEti).toBe(1_125);
  });
});
