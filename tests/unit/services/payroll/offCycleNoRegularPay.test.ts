/**
 * Wave 6 OC, review #1620 breaker L2 (revised in its delta): an OFF-CYCLE line that pays NO regular remuneration takes no
 * PAYE on regular pay (payeCumulative): its month's final regular run already took the cumulative catch-up. The oracle's
 * termination case (R10 000 leave pay after June's regular R20 000) was charged 2c of regular-pay catch-up from the
 * days-based AE; it now pays the annual payment's tax alone, 2192.04 (4c of ruling 5).
 * A REGULAR line keeps the full cumulative method: February's line with only a bonus still withholds the year's
 * shortfall (rev1620-noregularpay-feb, R25 457). An off-cycle line with regular pay keeps its regular part.
 */
import { describe, expect, it } from 'vitest';
import { loadCases } from '../../../fixtures/payroll-oracle/oracle';
import { buildCaseInput } from '../../../fixtures/payroll-oracle/oracleInput';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import { expectRecomputes } from './payrollExplainRecompute.helpers';

const termination = () => loadCases().find((c) => c.id === 'offcycle-termination-leave-after-regular')!;
const hasStep = (r: ReturnType<typeof calculatePayrollLine>, key: string) => r.explanations.paye.steps.some((s) => s.key === key);

describe('PAYE on a line with no regular remuneration', () => {
  it('the termination leave pay alone: no regular part, the annual payment\'s tax only (2192.04)', () => {
    const r = calculatePayrollLine(buildCaseInput(termination()));
    expect(r.periodicTaxable).toBe(0);
    expect(r.payeSplit.regular).toBe(0);
    expect(r.paye.monthlyPaye).toBe(2192.04);
    expect(r.payeSplit.annualPayment).toBe(2192.04);
    expect(hasStep(r, 'paye.noRegularPay')).toBe(true);
    expectRecomputes(r);
  });

  it('the same off-cycle line with R20 000 of regular pay keeps the cumulative regular part', () => {
    const input = buildCaseInput(termination());
    const salary = { ...input.components[0]!, component: { ...input.components[0]!.component, id: 'salary', sarsSourceCode: '3601', name: 'Basic salary' }, amount: 20_000 };
    const r = calculatePayrollLine({ ...input, components: [...input.components, salary] });
    expect(r.periodicTaxable).toBe(20_000);
    expect(r.payeSplit.regular).toBeGreaterThan(2_000); // the month's regular PAYE (about R2 115) plus its cumulative part
    expect(hasStep(r, 'paye.noRegularPay')).toBe(false);
    expectRecomputes(r);
  });

  it('a REGULAR line with no regular pay keeps the catch-up: February withholds the year\'s R1 000 shortfall (25 457)', () => {
    const ytd = { periods: 11, periodicTaxable: 220_000, annualPayments: 0, tablePaye: 2_115 * 11 - 1_000, medicalCredit: 0,
      additionalMedicalCredit: 0, medicalSchemeFees: 0 };
    const input = { annualPaymentRemuneration: 10_000, annualPayments: 10_000, taxYear: 2027, rebateAge: 40, monthlyMedicalBeneficiaries: 0,
      medicalSchemeFees: 0, factor: 12, periodsInYear: 12, regularTaxable: 0, periodicRemuneration: 0, ytd };
    const regular = calculateCumulativePaye(input);
    expect(Math.round((ytd.tablePaye + regular.regular.monthlyPaye + regular.annualPaymentPaye) * 100) / 100).toBe(25_457);
    expect(regular.regular.monthlyPaye).toBeGreaterThan(0);
    // The same figures on an off-cycle line: the catch-up is the regular run's, not this line's.
    const offCycle = calculateCumulativePaye({ ...input, offCycleLine: true });
    expect(offCycle.regular.monthlyPaye).toBe(0);
    expect(offCycle.annualPaymentPaye).toBe(regular.annualPaymentPaye);
  });
});
