/**
 * W1 (wave 7 W53): a 53rd weekly / 27th fortnightly pay day in one tax year. SARS is silent on how to annualise it
 * (PAYE-GEN-01-G21 (2027) Rev 1 p. 9, the annual-equivalent formula, counts "total pay periods in tax year" and says
 * nothing of an extra pay day; PAYE-GEN-01-G01 is silent too), so per ruling 9 the engine keeps x 52 / x 26 and the
 * line carries a non-blocking WEEK_53_PAY_DAY warning. The oracle harness asserts a case's `expectedWarnings`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTRA_PAY_DAY, extraPayDayWarnings } from '@/modules/accounting/services/payroll/payFrequencyPeriods';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { BLOCKING_LINE_CODES, GROUP_LABEL } from '@/components/payroll/runWarningCodes';
import { validateCase } from '../../../fixtures/payroll-oracle/validate';
import { buildCaseInput, caseProblems, ORACLE_DIR, runCase, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';

const load = (id: string) => JSON.parse(readFileSync(join(ORACLE_DIR, `${id}.json`), 'utf8')) as OracleCase;
const codesOf = (c: OracleCase) => calculatePayrollLine(buildCaseInput(c)).validationResults.map(v => v.code);

describe('extraPayDayWarnings: only past the year (n > P), weekly and fortnightly', () => {
  it('weekly: n = 53 over P = 52 warns; n = 52 does not', () => {
    expect(extraPayDayWarnings('weekly', 53, 52).map(w => w.code)).toEqual([EXTRA_PAY_DAY]);
    expect(extraPayDayWarnings('weekly', 52, 52)).toEqual([]);
  });
  it('a starter whose first part week makes n = 52.4285 has a 53rd pay day: warns', () => {
    expect(extraPayDayWarnings('weekly', 52.4285, 52).map(w => w.code)).toEqual([EXTRA_PAY_DAY]);
  });
  it('fortnightly: the 27th warns and names x 26; monthly never warns', () => {
    const [w] = extraPayDayWarnings('fortnightly', 27, 26);
    expect(w?.message).toMatch(/27th fortnightly pay day/);
    expect(w?.message).toMatch(/x 26/);
    expect(extraPayDayWarnings('fortnightly', 26, 26)).toEqual([]);
    expect(extraPayDayWarnings('monthly', 13, 12)).toEqual([]);
  });
  it('is a warning, cites G21, and names the alternate tax period', () => {
    const [w] = extraPayDayWarnings('weekly', 53, 52);
    expect(w?.severity).toBe('warning');
    expect(w?.message).toMatch(/53rd weekly pay day/);
    expect(w?.message).toMatch(/PAYE-GEN-01-G21/);
    expect(w?.message).toMatch(/alternate tax period/);
  });
});

describe('the engine writes WEEK_53_PAY_DAY on the line (version 22)', () => {
  it('week 53 of a Sunday-paid year carries it; the same line with 51 priors (week 52) does not', () => {
    const c53 = load('weekly-week-53-pay-sunday');
    expect(codesOf(c53)).toContain(EXTRA_PAY_DAY);
    const c52 = { ...c53, input: { ...c53.input, priorPeriods: c53.input.priorPeriods!.slice(1) } };
    expect(codesOf(c52)).not.toContain(EXTRA_PAY_DAY);
  });
  it('the 27th fortnightly line carries it, the 26th does not', () => {
    const c53 = load('weekly-week-53-pay-sunday');
    const fortnight = (n: number): OracleCase => ({ ...c53, input: { ...c53.input,
      period: { ...c53.input.period, frequency: 'fortnightly', periodStart: '2027-02-15', periodEnd: '2027-02-28' },
      priorPeriods: Array.from({ length: n }, (_, i) => ({ ...c53.input.priorPeriods![0]!, frequency: 'fortnightly' as const,
        periodStart: new Date(Date.UTC(2026, 1, 16 + 14 * i)).toISOString().slice(0, 10), paye: 0 })) } });
    expect(codesOf(fortnight(26))).toContain(EXTRA_PAY_DAY);
    expect(codesOf(fortnight(25))).not.toContain(EXTRA_PAY_DAY);
  });
  it('the run page labels it and does not block approval on it', () => {
    expect(GROUP_LABEL[EXTRA_PAY_DAY]).toMatch(/53rd weekly|27th fortnightly/);
    expect(BLOCKING_LINE_CODES.has(EXTRA_PAY_DAY)).toBe(false);
  });
});

describe('oracle harness: expectedWarnings (absent = not asserted; present = the exact set of codes)', () => {
  const FILE = 'weekly-week-53-pay-sunday.json';
  const raw = () => JSON.parse(readFileSync(join(ORACLE_DIR, FILE), 'utf8')) as Record<string, unknown>;

  it('validates: an array of distinct upper-case codes, nothing else', () => {
    expect(() => validateCase({ ...raw(), expectedWarnings: [] }, FILE)).not.toThrow();
    for (const bad of ['WEEK_53_PAY_DAY', ['week53'], ['A', 'A'], [1]]) {
      expect(() => validateCase({ ...raw(), expectedWarnings: bad }, FILE), JSON.stringify(bad)).toThrow(/expectedWarnings/);
    }
  });
  it('runCase returns the line\'s codes and caseProblems names a missing or an extra one', () => {
    const c = load('weekly-week-53-pay-sunday');
    expect(runCase(c).warnings).toContain(EXTRA_PAY_DAY);
    expect(caseProblems({ ...c, expectedWarnings: [] }, undefined).join()).toMatch(/warnings.*WEEK_53_PAY_DAY/);
    expect(caseProblems({ ...c, expectedWarnings: [EXTRA_PAY_DAY, 'NOT_RAISED'] }, undefined).join()).toMatch(/NOT_RAISED/);
    const { expectedWarnings: _absent, ...unasserted } = c;
    expect(caseProblems({ ...unasserted, expectedWarnings: undefined }, undefined)).toEqual([]);
  });
  it('both week-53 cases expect it; the week-52 control expects none', () => {
    for (const id of ['weekly-week-53-pay-sunday', 'weekly-week-53-medical-retirement']) {
      expect(load(id).expectedWarnings, id).toContain(EXTRA_PAY_DAY);
    }
    expect(load('weekly-week-52-pay-friday').expectedWarnings).toEqual([]);
  });
});
