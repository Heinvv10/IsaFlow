/**
 * IRP5 source-code mapping for UIF and SDL.
 * SARS: 4141 = total UIF (employee + employer), 4142 = SDL, 4150 = a reason
 * code for non-deduction of tax (never an amount). Runs without a database:
 * the sars_source_codes lookup is stubbed.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/sarsCodesService', () => ({
  // The stored rows still carry the old labels and categories.
  getSarsCodeNearest: vi.fn(async (code: string) => ({
    '3601': { description: 'Gross salary/wages', category: 'income' },
    '4102': { description: 'PAYE (Pay As You Earn)', category: 'deduction' },
    '4141': { description: 'UIF contributions (employee)', category: 'deduction' },
    '4142': { description: 'UIF contributions (employer)', category: 'employer' },
  } as Record<string, unknown>)[code] ?? null),
  categoryToComponentType: (category: string) => category,
}));

import {
  buildIRP5Certificate,
  calculateIRP5SourceCodes,
  type IRP5EmployeeData,
} from '@/modules/accounting/services/reports/irp5Service';

const data: IRP5EmployeeData = {
  grossSalary: 300_000, commission: 0, overtime: 0, bonus: 0, travelAllowance: 0,
  pensionContribEmployee: 0, medicalAidEmployee: 0, retirementAnnuity: 0,
  paye: 55_000, uifEmployee: 2_136.12, uifEmployer: 2_136.12, sdl: 3_000,
};

describe('IRP5 UIF and SDL codes', () => {
  it('4141 is employee + employer UIF and says so', async () => {
    const codes = await calculateIRP5SourceCodes(data, 2027);
    const c = codes.find((x) => x.code === '4141');
    expect(c?.amount).toBe(4_272.24);
    expect(c?.description).toBe('UIF contributions (employee and employer)');
  });

  it('4142 is SDL and does not carry the stored "employer UIF" label', async () => {
    const codes = await calculateIRP5SourceCodes(data, 2027);
    const c = codes.find((x) => x.code === '4142');
    expect(c?.amount).toBe(3_000);
    expect(c?.description).toBe('Skills Development Levy (SDL)');
  });

  it('never emits 4150', async () => {
    const codes = await calculateIRP5SourceCodes(data, 2027);
    expect(codes.map((x) => x.code)).not.toContain('4150');
  });

  it('keeps the employer share of UIF out of the employee deductions', async () => {
    const cert = await buildIRP5Certificate({
      employeeData: data, employeeName: 'A B', idNumber: '8501015009081', taxNumber: '1',
      employerName: 'E', employerPayeRef: '7001234567', taxYear: 2027,
      periodStart: '2026-03-01', periodEnd: '2027-02-28',
    });
    expect(cert.totalDeductions).toBe(57_136.12);   // PAYE 55 000 + employee UIF 2 136.12
    expect(cert.netRemuneration).toBe(242_863.88);
  });
});

/**
 * Wave 6 EF: every field goes to the code the PAYE BRS defines for it. SARS PAYE BRS - PAYE Employer Reconciliation
 * V25.3.0 (Jun-26; PDF sha256 14ec0e57…), section 6.5-6.7, PDF pages: 3601 income p.80; 3605 annual payment, 3606
 * commission and 3607 overtime p.82; 3701 travel allowance p.85 (3702 is REIMBURSIVE travel, p.86); 4001 pension
 * fund p.101; 4005 medical scheme fees p.101 (4003 is the PROVIDENT fund, 4004 is arrear provident, "not applicable
 * from 2010; include in code 4003"); 4006 retirement annuity fund p.102; 4102 PAYE, 4141 UIF and 4142 SDL p.109.
 * The mapping emitted overtime as 3801 (general fringe benefits, p.92), commission as 3701, travel as 3702, medical
 * aid as 4003 and the RA as 4004.
 */
describe('IRP5 income and deduction codes follow the PAYE BRS V25.3.0', () => {
  const every: IRP5EmployeeData = {
    grossSalary: 3_600_000, commission: 110_000, overtime: 120_000, bonus: 300_000, travelAllowance: 240_000,
    pensionContribEmployee: 216_000, medicalAidEmployee: 180_000, retirementAnnuity: 90_000,
    paye: 720_000, uifEmployee: 2_136.12, uifEmployer: 2_136.12, sdl: 42_600,
  };
  const codeOf = async (amount: number) => (await calculateIRP5SourceCodes(every, 2027)).filter((c) => c.amount === amount).map((c) => c.code);

  it.each([
    ['grossSalary', '3601', 3_600_000],
    ['bonus', '3605', 300_000],
    ['commission', '3606', 110_000],
    ['overtime', '3607', 120_000],
    ['travelAllowance', '3701', 240_000],
    ['pensionContribEmployee', '4001', 216_000],
    ['medicalAidEmployee', '4005', 180_000],
    ['retirementAnnuity', '4006', 90_000],
    ['paye', '4102', 720_000],
    ['sdl', '4142', 42_600],
  ] as const)('%s -> %s', async (_field, code, amount) => {
    expect(await codeOf(amount)).toEqual([code]);
  });

  it('never emits 3801 (fringe), 3702 (reimbursive travel), 4003 (provident) or 4004 (deprecated) for these fields', async () => {
    const codes = (await calculateIRP5SourceCodes(every, 2027)).map((c) => c.code);
    for (const wrong of ['3801', '3702', '4003', '4004']) expect(codes).not.toContain(wrong);
  });
});
