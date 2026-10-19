/**
 * IRP5 source-code mapping for UIF and SDL.
 * SARS: 4141 = total UIF (employee + employer), 4142 = SDL, 4150 = a reason
 * code for non-deduction of tax (never an amount). Runs without a database:
 * the sars_source_codes lookup is stubbed.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/sarsCodesService', () => ({
  // The stored rows still carry the old labels and categories.
  getSarsCode: vi.fn(async (code: string) => ({
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
