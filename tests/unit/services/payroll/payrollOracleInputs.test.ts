/**
 * What of a fixture's own inputs reaches the calculator call in runCase (O2 review carry-over, wave 5). The ts-* guard cases
 * pass without this only because the calculator did not look at status or hours; they say nothing unless the status and
 * the hours get there. Each input is either passed (checked per fixture below) or named with the PR that will take it:
 * a new fixture key that is neither is red.
 */
import { describe, expect, it } from 'vitest';
import { buildCaseInput, loadCases, oracleTaxStatus } from '../../../fixtures/payroll-oracle/oracle';

const cases = loadCases();

/** The `unmodelled` keys buildCaseInput passes to the calculator (as a work term). */
const PASSED = ['ordinaryHoursPerWeek', 'hoursPerDay', 'dayRate'];
/** The keys the calculator cannot take yet, each with the PR that wires it (or why it is only context). */
const NOT_YET: Record<string, string> = {
  monthlyHours: 'ET', ordinaryHoursWage: 'ET',
  erMedicalContribution: 'FB', travelBusinessUseAtLeast80Pct: 'FB', vehicleDeterminedValue: 'FB', vehicleBenefitPctOfValue: 'FB',
  maintenancePlanIncluded: 'FB', businessUseAtLeast80Pct: 'FB',
  fixedAmountDirective: 'DR', fixedRateDirectivePercent: 'DR',
  erRetirementPctOfRfi: 'RF', rfiBase: 'RF',
  daysWorked: 'context only: the case notes use it to reach the day rate', employmentBasis: 'context only: the classifier works it out from the hours',
  writtenDeclarationHeld: 'not recorded by IsaFlow yet (employmentTerms.ts, the PAYE_OUTSIDE_TABLES warning)',
};

describe('every fixture input reaches the calculator, or has a named owner', () => {
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
  });

  it('the cases that turn on them are there: a contractor, a director, hours and a day rate', () => {
    const inputs = cases.map(c => buildCaseInput(c).employee);
    expect(inputs.filter(e => e.taxStatus === 'independent_contractor').length).toBeGreaterThanOrEqual(2);
    expect(inputs.filter(e => e.taxStatus === 'director').length).toBeGreaterThanOrEqual(1);
    expect(inputs.filter(e => e.dailyRate != null && e.hoursPerWeek != null).length).toBeGreaterThanOrEqual(4);
  });
});
