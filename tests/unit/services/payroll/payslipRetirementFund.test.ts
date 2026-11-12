/**
 * Wave 5 RF round 1 (browser M): the employer's retirement fund contribution is visible on the payslip. The non-cash 3817 benefit
 * says it is also counted as the employee's retirement contribution, and a "Retirement fund contributions (counted for your tax)"
 * section shows the employee's own and the employer's deemed contribution (PAYE-GEN-01-G21 (2027) p. 10).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => { throw new Error('no database in this test'); }), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { buildPayslipPdf } from '@/modules/accounting/services/payroll/payslipPdf';
import { DEEMED_FUND_NOTE, itemisePayslip } from '@/modules/accounting/services/payroll/payslipItems';
import type { Payslip } from '@/modules/accounting/services/payroll/payslipModel';

const breakdown = [
  { componentId: 's', componentName: 'Basic Salary', sarsSourceCode: '3601', amount: 30000, isTaxable: true, isUifApplicable: true },
  { componentId: 'p', componentName: 'Pension', sarsSourceCode: '4001', amount: 1500, isTaxable: true, isUifApplicable: false, retirementContribution: true },
  { componentId: 'r', componentName: 'Employer pension', sarsSourceCode: '3817', amount: 2250, isTaxable: true, isUifApplicable: true, isNonCash: true },
];
const types = new Map([['s', 'earning'], ['p', 'deduction'], ['r', 'earning']]);
const stored = { grossPay: 30000, paye: 4681, uifEmployee: 177.12, uifEmployer: 177.12, sdl: 300, netPay: 30000 - 4681 - 177.12 - 1500, breakdown };

describe('itemisePayslip', () => {
  it('labels the 3817 benefit as also counted as the employee\'s contribution, and totals own and deemed', () => {
    const slip = itemisePayslip(stored, types);
    expect(slip.benefits).toEqual([{ label: `Employer pension (${DEEMED_FUND_NOTE})`, code: '3817', amount: 2250 }]);
    expect(slip.retirementFund).toEqual({ own: 1500, employerDeemed: 2250 });
  });
  it('no retirement section without contributions', () => {
    expect(itemisePayslip({ ...stored, breakdown: [breakdown[0]] , netPay: 30000 - 4681 - 177.12 }, types).retirementFund).toBeNull();
  });
});

describe('the payslip PDF', () => {
  it('prints the benefit note and the retirement section with its total', async () => {
    const slip: Payslip = {
      ...itemisePayslip(stored, types),
      employeeId: 'e1', employeeNumber: 'E-1', employeeName: 'Rufaro Pension', taxNumber: '0123456789', paymentMethod: 'eft',
      bankLastFour: '3456', bankName: 'FNB', bankIncomplete: false,
      workedOrdinary: null, workedOvertime: null, occupation: null, payBasis: 'monthly', hoursPerWeek: null, hoursPerDay: null, hourlyRate: null, dailyRate: null,
      yearToDate: { grossPay: 30000, taxableIncome: 32250, paye: 4681, uifEmployee: 177.12, netPay: 23641.88 },
    };
    const pdf = await buildPayslipPdf({ runId: 'r', periodMonth: 11, periodYear: 2026, runDate: '2026-11-25', final: true,
      employer: { name: 'Fixture (Pty) Ltd', address: '1 Main Road' }, payslips: [slip] });
    const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> } };
    const text = (await new PDFParse({ data: pdf }).getText()).text.replace(/\s+/g, ' ');
    expect(text).toContain('also counted as your retirement contribution');
    expect(text).toContain('Retirement fund contributions (counted for your tax)');
    expect(text).toMatch(/Employer contribution, counted as yours R ?2[  ]?250\.00/);
    expect(text).toMatch(/Total counted for the retirement fund deduction R ?3[  ]?750\.00/);
  });
});
