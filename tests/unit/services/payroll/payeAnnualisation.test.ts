/**
 * Wave-6 AN: days-based annualisation (ruling 5, vendor parity with Sage: 365 ÷ 30.4166 a month; ruling 16: × 26 and
 * × 52 for fortnightly and weekly). Source and reasoning: src/modules/accounting/services/payroll/annualisationFactor.ts.
 * The statutory × 12 (SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 8) is what AN departs from, by a few cents a year.
 */
import { describe, it, expect } from 'vitest';
import { annualisationFactor, annualisationFactorWords } from '@/modules/accounting/services/payroll/annualisationFactor';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import { annualTaxAfterCredits } from '@/modules/accounting/services/payroll/payeEngine';
import { getTaxYearConfig } from '@/modules/accounting/services/payroll/taxTables';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { buildCaseInput, loadCases } from '../../../fixtures/payroll-oracle/oracle';
import { stepsByKey } from './payrollExplainRecompute.helpers';
import { figureToExplanation } from '@/components/payroll/lineExplanationModel';

const NONE: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 };
const base = { taxYear: 2027, rebateAge: 46, monthlyMedicalBeneficiaries: 0, medicalSchemeFees: 0 };
const tax = (x: number) => annualTaxAfterCredits({ ageAtPeriodEnd: 46, monthlyMedicalBeneficiaries: 0, taxYear: 2027, annualTaxableIncome: x }).annualTax;
const cents = (n: number) => Math.round(n * 100);
/** Sage's monthly factor, written out here, not read from the engine. */
const SAGE_F = 365 / 30.4166;

function year(salary: number, months: number, extra: { retirementContributions?: number } = {}) {
  let ytd: PayeYearToDate = NONE;
  const out = [];
  for (let i = 0; i < months; i++) {
    const r = calculateCumulativePaye({ ...base, ...extra, factor: annualisationFactor('monthly'), regularTaxable: salary, annualPayments: 0, periodicRemuneration: salary, annualPaymentRemuneration: 0, ytd });
    out.push(r);
    ytd = {
      ...ytd, periods: ytd.periods + 1, periodicTaxable: ytd.periodicTaxable + salary, tablePaye: ytd.tablePaye + r.regular.monthlyPaye,
      retirementContributions: (ytd.retirementContributions ?? 0) + (extra.retirementContributions ?? 0),
      retirementDeduction: (ytd.retirementDeduction ?? 0) + r.retirementDeduction, retirementCapPeriods: (ytd.retirementCapPeriods ?? 0) + 1,
    };
  }
  return out;
}

describe('annualisationFactor (AN)', () => {
  it('monthly is Sage\'s 365 ÷ 30.4166 (12.0000263), not 12; fortnightly 26 and weekly 52 (ruling 16)', () => {
    expect(annualisationFactor('monthly')).toBe(SAGE_F);
    expect(annualisationFactor('monthly')).toBeCloseTo(12.0000263, 7);
    expect(annualisationFactor('monthly')).not.toBe(12);
    expect(annualisationFactor('fortnightly')).toBe(26);
    expect(annualisationFactor('weekly')).toBe(52);
    expect(annualisationFactorWords(SAGE_F)).toBe('365 ÷ 30.4166');
    expect(annualisationFactorWords(52)).toBe('52');
  });

  it('the annual equivalent of R50 000 is R50 000 × 365 ÷ 30.4166, Sage\'s figure to the rand (phekis: R600 001.37)', () => {
    const [m1] = year(50_000, 1);
    expect(m1!.trace.annualEquivalent).toBe(50_000 * SAGE_F);
    expect(m1!.annualEquivalent).toBe(600_001.32);
    expect(m1!.trace.factor).toBe(SAGE_F);
  });

  it('the 12-month identity: twelve equal months sum to tax(12 × pay × F ÷ 12) × 12 ÷ F, 3.9c above tax(12 × pay)', () => {
    const months = year(20_000, 12);
    const sum = months.reduce((t, m) => t + cents(m.regular.monthlyPaye), 0);
    const identity = (tax((12 * 20_000 * SAGE_F) / 12) * 12) / SAGE_F;
    expect(sum).toBe(cents(identity));
    // The statutory year (G21 p. 8, × 12) is tax(240 000) = 25 380.00; AN's is 25 380.04.
    expect(tax(240_000)).toBe(25_380);
    expect(cents(identity) - cents(tax(240_000))).toBe(4);
  });

  it('the retirement cap to date is the annual cap × periods ÷ F, so twelve months reach cap × 12 ÷ F', () => {
    // R200 000 a month with R50 000 to an RA: the annual cap binds (2027: R430 000; G21 (2027) Rev 1 p. 10).
    const months = year(200_000, 12, { retirementContributions: 50_000 });
    const cap = getTaxYearConfig(2027).retirementDeductionCap;
    expect(months[0]!.trace.capToDate).toBe(cap / SAGE_F);
    expect(months[11]!.trace.capToDate).toBe((cap * 12) / SAGE_F);
    const recorded = months.reduce((t, m) => t + cents(m.retirementDeduction), 0);
    expect(recorded).toBe(cents((cap * 12) / SAGE_F));
  });

  it('a monthly line is costed on F, and its explanation states it (phekis: R50 000, Sage PAYE 11 075.60 to the cent)', () => {
    const line = calculatePayrollLine(buildCaseInput(loadCases().find(c => c.id === 'sage-2027-03-phekis')!));
    expect(line.paye.monthlyPaye).toBe(11_075.6);
    const steps = stepsByKey(line.explanations.paye);
    expect(steps.get('paye.annualisationFactor')!.amount).toBe(SAGE_F);
    expect(steps.get('paye.annualEquivalent')!.formula).toMatch(/50.000\.00 × 365 ÷ 30\.4166 ÷ 1$/);
  });

  it('the drawer shows the factor to 7 decimals (12.0000263), and whole counts as they are', () => {
    const line = calculatePayrollLine(buildCaseInput(loadCases().find(c => c.id === 'sage-2027-03-phekis')!));
    const lines = figureToExplanation(line.explanations.paye, 'Phekis').lines;
    expect(lines.find(l => l.label === 'Periods in a year (the annualisation factor)')?.value).toBe('12.0000263');
    expect(lines.find(l => l.label === 'Periods paid, this one included')?.value).toBe('1');
  });
});
