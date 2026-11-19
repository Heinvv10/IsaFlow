/**
 * Wave 6 OC, review #1620 breaker L2: a line that pays NO regular remuneration takes no PAYE on regular pay
 * (payeCumulative). The oracle's termination case (R10 000 leave pay after June's regular R20 000) was charged 2c of
 * regular-pay catch-up from the days-based AE; it now pays the annual payment's tax alone, 2192.04 (4c of ruling 5).
 * Keyed on the line's periodic remuneration, never the run kind: the same line with any regular pay keeps the catch-up.
 */
import { describe, expect, it } from 'vitest';
import { loadCases } from '../../../fixtures/payroll-oracle/oracle';
import { buildCaseInput } from '../../../fixtures/payroll-oracle/oracleInput';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
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

  it('the same line with R20 000 of regular pay keeps the cumulative regular part (not keyed on the run kind)', () => {
    const input = buildCaseInput(termination());
    const salary = { ...input.components[0]!, component: { ...input.components[0]!.component, id: 'salary', sarsSourceCode: '3601', name: 'Basic salary' }, amount: 20_000 };
    const r = calculatePayrollLine({ ...input, components: [...input.components, salary] });
    expect(r.periodicTaxable).toBe(20_000);
    expect(r.payeSplit.regular).toBeGreaterThan(2_000); // the month's regular PAYE (about R2 115) plus its cumulative part
    expect(hasStep(r, 'paye.noRegularPay')).toBe(false);
    expectRecomputes(r);
  });
});
