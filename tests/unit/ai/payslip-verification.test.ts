/**
 * TDD: Payslip/IRP5 Cross-Verification
 */

import { describe, it, expect } from 'vitest';
import {
  parsePayslipExtractionResponse,
  matchEmployeeFromExtraction,
  verifyPayslipAgainstPayroll,
  validatePayslipExtraction,
  type ExtractedPayslip,
  type PayrollRecord,
} from '@/modules/accounting/services/payslipVerificationService';

const payslip: ExtractedPayslip = {
  employeeName: 'Sipho Nkosi', idNumber: '9001015800081',
  taxNumber: null, employerName: 'ISAFlow Demo', employerPayeRef: null,
  period: '2026-03', grossPay: 21000, netPay: 16500,
  paye: 2500, uif: 210, sdl: 210, pensionContrib: null, medicalAid: null,
  overtime: 0, bonus: 0, confidence: 0.9,
};

const payroll: PayrollRecord = {
  employeeId: 'emp-001', employeeName: 'Sipho Nkosi', idNumber: '9001015800081',
  grossPay: 21000, netPay: 16500, paye: 2500, uif: 210, sdl: 210, pension: 0, medical: 0,
};

const employees = [
  { id: 'emp-001', name: 'Sipho Nkosi', idNumber: '9001015800081' },
  { id: 'emp-002', name: 'Lerato Molefe', idNumber: '9205205100086' },
];

describe('Payslip Response Parsing', () => {
  it('parses employee name and ID', () => {
    const r = parsePayslipExtractionResponse('{"employeeName":"Sipho Nkosi","idNumber":"9001015800081","grossPay":21000,"paye":2500,"uif":210,"sdl":210,"netPay":16500}');
    expect(r!.employeeName).toBe('Sipho Nkosi');
    expect(r!.idNumber).toBe('9001015800081');
  });

  it('parses financial fields', () => {
    const r = parsePayslipExtractionResponse('{"employeeName":"Test","grossPay":25000,"paye":3000,"uif":250,"sdl":250,"netPay":21500}');
    expect(r!.grossPay).toBe(25000);
    expect(r!.paye).toBe(3000);
  });

  it('handles null fields', () => {
    const r = parsePayslipExtractionResponse('{"employeeName":"Test","grossPay":20000,"netPay":16000}');
    expect(r!.paye).toBeNull();
  });

  it('handles malformed JSON', () => {
    expect(parsePayslipExtractionResponse('bad json')).toBeNull();
  });
});

describe('Employee Matching', () => {
  it('matches by exact ID number', () => {
    const m = matchEmployeeFromExtraction(payslip, employees);
    expect(m!.employeeId).toBe('emp-001');
    expect(m!.matchMethod).toBe('id_number');
  });

  it('matches by name when ID not available', () => {
    const m = matchEmployeeFromExtraction({ ...payslip, idNumber: null }, employees);
    expect(m!.employeeId).toBe('emp-001');
    expect(m!.matchMethod).toBe('name');
  });

  it('returns null when no match', () => {
    const m = matchEmployeeFromExtraction({ ...payslip, idNumber: '0000000000000', employeeName: 'Unknown Person' }, employees);
    expect(m).toBeNull();
  });

  it('prefers ID match over name match', () => {
    const m = matchEmployeeFromExtraction(payslip, employees);
    expect(m!.matchMethod).toBe('id_number');
  });
});

describe('Payslip Verification Against Payroll', () => {
  it('reports no discrepancies when all match', () => {
    const r = verifyPayslipAgainstPayroll(payslip, payroll);
    expect(r.valid).toBe(true);
    expect(r.discrepancies.length).toBe(0);
  });

  it('flags gross pay mismatch as error', () => {
    const r = verifyPayslipAgainstPayroll({ ...payslip, grossPay: 25000 }, payroll);
    expect(r.valid).toBe(false);
    expect(r.discrepancies.some(d => d.field === 'grossPay' && d.severity === 'error')).toBe(true);
  });

  it('flags PAYE mismatch as error', () => {
    const r = verifyPayslipAgainstPayroll({ ...payslip, paye: 3000 }, payroll);
    expect(r.discrepancies.some(d => d.field === 'paye' && d.severity === 'error')).toBe(true);
  });

  it('flags UIF mismatch as warning', () => {
    const r = verifyPayslipAgainstPayroll({ ...payslip, uif: 300 }, payroll);
    expect(r.discrepancies.some(d => d.field === 'uif' && d.severity === 'warning')).toBe(true);
  });

  it('tolerates R1 rounding differences', () => {
    const r = verifyPayslipAgainstPayroll({ ...payslip, grossPay: 21000.50 }, payroll);
    expect(r.valid).toBe(true);
  });

  it('returns score based on matching fields', () => {
    const r = verifyPayslipAgainstPayroll(payslip, payroll);
    expect(r.score).toBeGreaterThanOrEqual(0.9);
  });
});

describe('Payslip Validation', () => {
  it('rejects with no grossPay', () => {
    expect(validatePayslipExtraction({ ...payslip, grossPay: null }).valid).toBe(false);
  });

  it('rejects with no employee identifier', () => {
    expect(validatePayslipExtraction({ ...payslip, employeeName: null, idNumber: null }).valid).toBe(false);
  });

  it('accepts with grossPay and employee identifier', () => {
    expect(validatePayslipExtraction(payslip).valid).toBe(true);
  });
});
