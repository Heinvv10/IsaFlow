/**
 * TDD: IRP5/IT3(a) Certificate Generation Tests
 * RED phase — written before implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateIRP5SourceCodes,
  buildIRP5Certificate,
  buildEMP501Summary,
  validateIRP5Data,
  formatSARSAmount,
  SARS_SOURCE_CODES,
  type IRP5EmployeeData,
  type IRP5Certificate,
  type EMP501Summary,
} from '@/modules/accounting/services/irp5Service';

// ═══════════════════════════════════════════════════════════════════════════
// SARS SOURCE CODES
// ═══════════════════════════════════════════════════════════════════════════

describe('SARS Source Codes', () => {
  it('has code 3601 for gross salary', () => {
    expect(SARS_SOURCE_CODES['3601']).toBeDefined();
    expect(SARS_SOURCE_CODES['3601'].description).toContain('salary');
  });

  it('has code 3701 for commission', () => {
    expect(SARS_SOURCE_CODES['3701']).toBeDefined();
  });

  it('has code 3801 for overtime', () => {
    expect(SARS_SOURCE_CODES['3801']).toBeDefined();
  });

  it('has code 4001 for pension fund contributions', () => {
    expect(SARS_SOURCE_CODES['4001']).toBeDefined();
  });

  it('has code 4003 for medical aid', () => {
    expect(SARS_SOURCE_CODES['4003']).toBeDefined();
  });

  it('has code 4102 for PAYE', () => {
    expect(SARS_SOURCE_CODES['4102']).toBeDefined();
    expect(SARS_SOURCE_CODES['4102'].description).toContain('PAYE');
  });

  it('has code 4141 for UIF employee', () => {
    expect(SARS_SOURCE_CODES['4141']).toBeDefined();
  });

  it('has code 4142 for UIF employer', () => {
    expect(SARS_SOURCE_CODES['4142']).toBeDefined();
  });

  it('has code 4150 for SDL', () => {
    expect(SARS_SOURCE_CODES['4150']).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IRP5 SOURCE CODE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

describe('IRP5 Source Code Calculation', () => {
  const sampleEmployee: IRP5EmployeeData = {
    grossSalary: 360000, // R30k/month * 12
    commission: 0,
    overtime: 12000,
    bonus: 30000,
    travelAllowance: 24000,
    pensionContribEmployee: 21600, // 6% of gross
    medicalAidEmployee: 18000,
    retirementAnnuity: 0,
    paye: 72000,
    uifEmployee: 2136.12, // 1% of R17,811.84 * 12
    uifEmployer: 2136.12,
    sdl: 4260, // 1% of total remuneration
  };

  it('maps gross salary to code 3601', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '3601')?.amount).toBe(360000);
  });

  it('maps overtime to code 3801', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '3801')?.amount).toBe(12000);
  });

  it('maps bonus to code 3605', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '3605')?.amount).toBe(30000);
  });

  it('maps travel allowance to code 3702', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '3702')?.amount).toBe(24000);
  });

  it('maps pension contribution to code 4001', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '4001')?.amount).toBe(21600);
  });

  it('maps medical aid to code 4003', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '4003')?.amount).toBe(18000);
  });

  it('maps PAYE to code 4102', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '4102')?.amount).toBe(72000);
  });

  it('maps UIF employee to code 4141', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '4141')?.amount).toBe(2136.12);
  });

  it('maps UIF employer to code 4142', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '4142')?.amount).toBe(2136.12);
  });

  it('maps SDL to code 4150', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    expect(codes.find(c => c.code === '4150')?.amount).toBe(4260);
  });

  it('omits zero-value codes', () => {
    const codes = calculateIRP5SourceCodes(sampleEmployee);
    const commissionCode = codes.find(c => c.code === '3701');
    expect(commissionCode).toBeUndefined(); // commission is 0
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IRP5 CERTIFICATE BUILDING
// ═══════════════════════════════════════════════════════════════════════════

describe('IRP5 Certificate Building', () => {
  const sampleData: IRP5EmployeeData = {
    grossSalary: 300000,
    commission: 0,
    overtime: 0,
    bonus: 0,
    travelAllowance: 0,
    pensionContribEmployee: 18000,
    medicalAidEmployee: 12000,
    retirementAnnuity: 0,
    paye: 55000,
    uifEmployee: 2136.12,
    uifEmployer: 2136.12,
    sdl: 3000,
  };

  it('builds certificate with employee details', () => {
    const cert = buildIRP5Certificate({
      employeeData: sampleData,
      employeeName: 'John Smith',
      idNumber: '8501015009081',
      taxNumber: '1234567890',
      employerName: 'IsaFlow Pty Ltd',
      employerPayeRef: '7001234567',
      taxYear: 2026,
      periodStart: '2025-03-01',
      periodEnd: '2026-02-28',
    });
    expect(cert.employeeName).toBe('John Smith');
    expect(cert.idNumber).toBe('8501015009081');
    expect(cert.taxYear).toBe(2026);
  });

  it('includes all non-zero source codes', () => {
    const cert = buildIRP5Certificate({
      employeeData: sampleData,
      employeeName: 'Test',
      idNumber: '8501015009081',
      taxNumber: '1234567890',
      employerName: 'Test Co',
      employerPayeRef: '7001234567',
      taxYear: 2026,
      periodStart: '2025-03-01',
      periodEnd: '2026-02-28',
    });
    expect(cert.sourceCodes.length).toBeGreaterThan(0);
    expect(cert.sourceCodes.every(sc => sc.amount > 0)).toBe(true);
  });

  it('calculates total gross income', () => {
    const cert = buildIRP5Certificate({
      employeeData: sampleData,
      employeeName: 'Test',
      idNumber: '8501015009081',
      taxNumber: '1234567890',
      employerName: 'Test Co',
      employerPayeRef: '7001234567',
      taxYear: 2026,
      periodStart: '2025-03-01',
      periodEnd: '2026-02-28',
    });
    expect(cert.totalGrossIncome).toBe(300000);
  });

  it('calculates total deductions', () => {
    const cert = buildIRP5Certificate({
      employeeData: sampleData,
      employeeName: 'Test',
      idNumber: '8501015009081',
      taxNumber: '1234567890',
      employerName: 'Test Co',
      employerPayeRef: '7001234567',
      taxYear: 2026,
      periodStart: '2025-03-01',
      periodEnd: '2026-02-28',
    });
    // PAYE + UIF employee + pension + medical = 55000 + 2136.12 + 18000 + 12000
    expect(cert.totalDeductions).toBeGreaterThan(80000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EMP501 SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

describe('EMP501 Summary', () => {
  it('aggregates monthly EMP201 data', () => {
    const monthly = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      paye: 6000,
      uif: 356,
      sdl: 350,
      totalEmployees: 5,
    }));
    const summary = buildEMP501Summary(monthly, 2026);
    expect(summary.totalPaye).toBe(72000); // 6000 * 12
    expect(summary.totalUif).toBe(4272); // 356 * 12
    expect(summary.totalSdl).toBe(4200); // 350 * 12
    expect(summary.taxYear).toBe(2026);
  });

  it('calculates total liability', () => {
    const monthly = [{ month: 1, paye: 10000, uif: 500, sdl: 300, totalEmployees: 3 }];
    const summary = buildEMP501Summary(monthly, 2026);
    expect(summary.totalLiability).toBe(10800); // 10000 + 500 + 300
  });

  it('handles empty months', () => {
    const summary = buildEMP501Summary([], 2026);
    expect(summary.totalPaye).toBe(0);
    expect(summary.totalLiability).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('IRP5 Data Validation', () => {
  it('validates valid IRP5 data', () => {
    expect(validateIRP5Data({
      employeeName: 'John Smith',
      idNumber: '8501015009081',
      taxNumber: '1234567890',
      grossSalary: 300000,
      paye: 55000,
    }).valid).toBe(true);
  });

  it('rejects missing employee name', () => {
    expect(validateIRP5Data({ employeeName: '', idNumber: '8501015009081', taxNumber: '123', grossSalary: 1, paye: 1 }).valid).toBe(false);
  });

  it('rejects invalid SA ID number (wrong length)', () => {
    expect(validateIRP5Data({ employeeName: 'Test', idNumber: '12345', taxNumber: '123', grossSalary: 1, paye: 1 }).valid).toBe(false);
  });

  it('accepts valid 13-digit SA ID', () => {
    expect(validateIRP5Data({ employeeName: 'Test', idNumber: '8501015009081', taxNumber: '123', grossSalary: 1, paye: 1 }).valid).toBe(true);
  });

  it('rejects negative gross salary', () => {
    expect(validateIRP5Data({ employeeName: 'Test', idNumber: '8501015009081', taxNumber: '123', grossSalary: -1, paye: 1 }).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

describe('SARS Amount Formatting', () => {
  it('formats to cents (no decimals)', () => {
    expect(formatSARSAmount(15000.50)).toBe('1500050');
  });

  it('formats zero', () => {
    expect(formatSARSAmount(0)).toBe('0');
  });

  it('rounds correctly', () => {
    expect(formatSARSAmount(100.999)).toBe('10100');
  });
});
