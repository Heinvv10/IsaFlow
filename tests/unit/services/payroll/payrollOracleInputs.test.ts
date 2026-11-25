/**
 * What of a fixture's own inputs reaches the calculator call in runCase (O2 review carry-over, wave 5). The ts-* guard cases
 * pass without this only because the calculator did not look at status or hours; they say nothing unless the status and
 * the hours get there. Each input is either passed (checked per fixture below) or named with the PR that will take it:
 * a new fixture key that is neither is red.
 */
import { isoOfDate } from '@/modules/accounting/services/payroll/payFrequencyPeriods';
import { describe, expect, it } from 'vitest';
import { buildCaseInput, loadCases, oracleTaxStatus } from '../../../fixtures/payroll-oracle/oracle';
import { runHoursOf } from '@/modules/accounting/services/payroll/payrollRunHours';
import { ordinaryWageCents } from '@/modules/accounting/services/payroll/etiHours';
import { UNMODELLED_KEYS } from '../../../fixtures/payroll-oracle/validate';

const cases = loadCases();

/** The `unmodelled` keys buildCaseInput passes to the calculator (as a work term, the run hours, the RF employer contribution: rfiInput.ts, the regular-pay directive, or the garnishee orders). */
const PASSED = ['ordinaryHoursPerWeek', 'hoursPerDay', 'dayRate', 'monthlyHours', 'ordinaryHoursWage', 'erRetirementPctOfRfi', 'rfiBase', 'dbMemberCategoryFactor', 'fixedAmountDirective', 'fixedRateDirectivePercent', 'garnisheeOrders',
  // FQc: the share of the period worked, from the case's dates; buildCaseInput refuses a stated fraction the dates do not give.
  'periodFraction',
  // RI: overtime and reimbursive travel (oracleInput.runInputUnitRows).
  'overtimeHours', 'overtimeMultiplier', 'businessKm', 'reimbursiveRatePerKm'];
/** The keys the calculator cannot take yet, each with the PR that wires it (or why it is only context). */
const NOT_YET: Record<string, string> = {
  erMedicalContribution: 'FB', travelBusinessUseAtLeast80Pct: 'FB', vehicleDeterminedValue: 'FB', vehicleBenefitPctOfValue: 'FB',
  maintenancePlanIncluded: 'FB', businessUseAtLeast80Pct: 'FB',
  daysWorked: 'context only: the case notes use it to reach the day rate', employmentBasis: 'context only: the classifier works it out from the hours',
  writtenDeclarationHeld: 'not recorded by IsaFlow yet (employmentTerms.ts, the PAYE_OUTSIDE_TABLES warning)',
  ordinarilyWorksSunday: 'context only: overtimeMultiplier already says 2x (BCEA s16(1): double pay only for a non-Sunday worker)',
};

describe('every fixture input reaches the calculator, or has a named owner', () => {
  it('validate.ts UNMODELLED_KEYS is exactly the passed and owned keys', () => {
    expect([...PASSED, ...Object.keys(NOT_YET)].sort()).toEqual([...UNMODELLED_KEYS].sort());
  });

  it('every unmodelled key is passed or owned', () => {
    const keys = new Set(cases.flatMap(c => Object.keys(c.input.unmodelled ?? {})));
    const unowned = [...keys].filter(k => !PASSED.includes(k) && !(k in NOT_YET));
    expect(unowned).toEqual([]);
    // and the lists are not stale
    expect(PASSED.filter(k => !keys.has(k))).toEqual([]);
    expect(Object.keys(NOT_YET).filter(k => !keys.has(k))).toEqual([]);
  });

  it.each(cases.map(c => [c.id, c] as const))('%s: the status and the hours are on the employee the calculator is given', (_id, c) => {
    const { employee } = buildCaseInput(c);
    expect(employee.taxStatus).toBe(oracleTaxStatus(c.input.employee.taxStatus));
    const u = c.input.unmodelled ?? {};
    expect(employee.hoursPerWeek ?? null).toBe(typeof u.ordinaryHoursPerWeek === 'number' ? u.ordinaryHoursPerWeek : null);
    expect(employee.hoursPerDay ?? null).toBe(typeof u.hoursPerDay === 'number' ? u.hoursPerDay : null);
    expect(employee.dailyRate ?? null).toBe(typeof u.dayRate === 'number' ? u.dayRate : null);
    expect(employee.employmentType).toBe(c.input.employee.taxStatus === 'temporary_part_time' ? 'casual' : 'permanent');
    // ET: the month's hours reach the calculator as the run hours, and the ordinary wage it derives is the fixture's.
    const { components } = buildCaseInput(c);
    // RI: the run hours are the ordinary hours only; ETI adds overtime once itself (etiHours.overtimeHours; review #1580 H1).
    expect(runHoursOf(employee, components)).toBe(typeof u.monthlyHours === 'number' ? u.monthlyHours : null);
    if (typeof u.ordinaryHoursWage === 'number') expect(ordinaryWageCents(components)).toBe(Math.round(u.ordinaryHoursWage * 100));
    // The directive (DR): a percentage as its fraction, an amount as is, else none.
    const d = buildCaseInput(c).regularPayDirective?.current ?? null;
    expect(d?.rate ?? null).toBe(typeof u.fixedRateDirectivePercent === 'number' ? u.fixedRateDirectivePercent / 100 : null);
    expect(d?.fixedAmount ?? null).toBe(typeof u.fixedAmountDirective === 'number' ? u.fixedAmountDirective : null);
  });

  it('the RF case reaches the calculator as a non-cash 3817 costed at 15% of its R20 000 RFI', () => {
    const rf = cases.find(c => c.id === 'rf-employer-contribution-15pct-rfi-cap-binds-on-total');
    if (!rf) throw new Error('RF case missing');
    const er = buildCaseInput(rf).components.find(c => c.component.sarsSourceCode === '3817');
    expect(er).toMatchObject({ amount: 3_000, isNonCash: true, percentOfRfi: 0.15, rfiBase: 20_000 });
  });

  it('the cases that turn on them are there: a contractor, a director, hours and a day rate', () => {
    const inputs = cases.map(c => buildCaseInput(c).employee);
    expect(inputs.filter(e => e.taxStatus === 'independent_contractor').length).toBeGreaterThanOrEqual(2);
    expect(inputs.filter(e => e.taxStatus === 'director').length).toBeGreaterThanOrEqual(1);
    expect(inputs.filter(e => e.dailyRate != null && e.hoursPerWeek != null).length).toBeGreaterThanOrEqual(4);
  });

  // W29 (wave 7 PRA, F4 rule 11): a component's window and the employee's end date reach the calculator, and the dated rows
  // are apportioned there exactly as the run's reading does (payrollRecurringShare), so the oracle asserts the share.
  it.each(cases.filter(c => c.input.employee.endDate !== undefined || c.input.components.some(x => x.effectiveFrom !== undefined)).map(c => [c.id, c] as const))(
    '%s: the end date and each dated row reach the calculator, at their share', (_id, c) => {
      const { employee, components } = buildCaseInput(c);
      expect(employee.endDate ? isoOfDate(employee.endDate) : undefined).toBe(c.input.employee.endDate);
      // A recurring row starting after the leaver's last day is dropped (round 3): the rest keep their order.
      const lastDay = c.input.employee.endDate;
      const kept = c.input.components.filter(x => !(lastDay && x.effectiveFrom !== undefined && x.effectiveFrom > lastDay && x.type === 'earning'));
      kept.forEach((x, i) => {
        const got = components[i]!;
        if (x.effectiveFrom === undefined) { expect(got.share).toBeUndefined(); expect(got.amount).toBe(x.amount); return; }
        expect(got).toMatchObject({ isRecurring: true, effectiveFrom: x.effectiveFrom, effectiveTo: x.effectiveTo ?? null });
        // A tiling run of one amount: the last row takes the remainder (R2-L1), within a cent of its own share.
        if (got.share) expect(Math.abs(got.amount - Math.round((x.amount * got.share.days / got.share.of) * 100) / 100)).toBeLessThanOrEqual(0.011);
        else expect(got.amount).toBe(x.amount);
      });
    },
  );

  it('the W29 cases apportion where ruling 19 says and only there', () => {
    const shareOf = (id: string) => {
      const c = cases.find(k => k.id === id);
      if (!c) throw new Error(`${id} missing`);
      return buildCaseInput(c).components.map(x => x.share ? `${x.share.days}/${x.share.of}` : 'whole');
    };
    expect(shareOf('recurring-start-mid-month-monthly')).toEqual(['whole', '12/23']);
    expect(shareOf('recurring-end-mid-month-monthly')).toEqual(['whole', '8/23']);
    expect(shareOf('recurring-start-mid-week-weekly')).toEqual(['whole', '4/7']);
    expect(shareOf('starter-mid-month-full-salary')).toEqual(['whole']);
    expect(shareOf('leaver-mid-month-full-salary')).toEqual(['whole']);
    expect(shareOf('leaver-raise-mid-month-sums-to-window')).toEqual(['7/11', '4/11']);
    expect(shareOf('starter-raise-mid-month-sums-to-window')).toEqual(['8/18', '10/18']);
    expect(shareOf('weekly-split-same-amount-sums-to-whole')).toEqual(['3/7', '4/7']);
    expect(shareOf('leaver-row-ends-on-end-date-mid-month-full')).toEqual(['whole']);
    expect(shareOf('leaver-row-after-end-not-paid')).toEqual(['whole']); // the later row is dropped: not paid
    expect(shareOf('three-rows-one-amount-sums-to-month')).toEqual(['7/23', '8/23', '8/23']);
  });

  // Review #1901 L3: overtime is priced on the basic in force on the period's last day, as production's monthlyBasicOf reads it.
  it('overtime after a mid-month raise is priced on the raised basic, not the row that ended', () => {
    const c = JSON.parse(JSON.stringify(cases.find(k => k.id === 'recurring-start-mid-month-monthly'))) as typeof cases[number];
    c.input.components = [
      { code: '3601', name: 'Basic salary', type: 'earning', amount: 4000, taxable: true, uif: true, sdl: true, effectiveFrom: '2020-03-01', effectiveTo: '2026-07-15' },
      { code: '3601', name: 'Basic salary (raised)', type: 'earning', amount: 4800, taxable: true, uif: true, sdl: true, effectiveFrom: '2026-07-16' },
    ];
    c.input.unmodelled = { ordinaryHoursPerWeek: 40, overtimeHours: 10, overtimeMultiplier: 1.5 };
    const ot = buildCaseInput(c).components.find(x => x.component.sarsSourceCode === '3607')!;
    // 4 800 / (40 x 52 / 12) = 27.69 an hour, x 1.5 x 10 hours = 415.35 (on the ended R4 000 row it would be 346.20).
    expect(ot.amount).toBe(415.35);
  });

  // Review #1901 round 3 L: dated rows are one component only when code AND name match, so two components of one SARS code
  // (a salary and an allowance on 3601) never share a remainder.
  it('dated rows of one code but different names are different components; same code and name, one', () => {
    const c = cases.find(k => k.id === 'leaver-raise-mid-month-sums-to-window')!;
    const ids = buildCaseInput(c).components.map(x => x.component.id);
    expect(new Set(ids).size).toBe(2);
    const w = cases.find(k => k.id === 'weekly-split-same-amount-sums-to-whole')!;
    expect(new Set(buildCaseInput(w).components.map(x => x.component.id)).size).toBe(1);
  });
});

