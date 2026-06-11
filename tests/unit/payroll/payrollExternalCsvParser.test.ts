import { describe, it, expect } from 'vitest';
import {
  parseExternalPayslipCsv,
  parseAmountToCents,
} from '@/modules/accounting/services/payroll/payrollExternalCsvParser';

describe('parseAmountToCents', () => {
  it('plain decimal', () => {
    expect(parseAmountToCents('1234.56')).toBe(123456);
  });

  it('blank means zero (payslip exports leave zeros blank)', () => {
    expect(parseAmountToCents('')).toBe(0);
    expect(parseAmountToCents('   ')).toBe(0);
  });

  it('currency symbol and spaces stripped', () => {
    expect(parseAmountToCents('R 1 234.56')).toBe(123456);
    expect(parseAmountToCents('R12 345.00')).toBe(1234500);
  });

  it('thousands comma with dot decimal', () => {
    expect(parseAmountToCents('1,234.56')).toBe(123456);
    expect(parseAmountToCents('12,345,678.90')).toBe(1234567890);
  });

  it('SA comma decimal', () => {
    expect(parseAmountToCents('1234,56')).toBe(123456);
    expect(parseAmountToCents('1 234,56')).toBe(123456);
  });

  it('lone comma with 3 digits after is a thousands separator', () => {
    expect(parseAmountToCents('1,234')).toBe(123400);
  });

  it('both separators — last one wins as decimal', () => {
    expect(parseAmountToCents('1.234.567,89')).toBe(123456789);
  });

  it('negatives: minus sign and accounting parentheses', () => {
    expect(parseAmountToCents('-123.45')).toBe(-12345);
    expect(parseAmountToCents('(123.45)')).toBe(-12345);
  });

  it('integer amount', () => {
    expect(parseAmountToCents('15000')).toBe(1500000);
  });

  it('more than 2 decimals rounds half away from zero', () => {
    expect(parseAmountToCents('1.005')).toBe(101);
    expect(parseAmountToCents('-1.005')).toBe(-101);
  });

  it('garbage is rejected', () => {
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('12.34.56,7,8')).toBeNull();
  });

  it('trailing separator is rejected, not silently truncated', () => {
    expect(parseAmountToCents('1,')).toBeNull();
    expect(parseAmountToCents('1.')).toBeNull();
  });
});

const HEADER = 'employee_number,employee_name,gross,paye,uif_employee,uif_employer,sdl,eti,net';

describe('parseExternalPayslipCsv', () => {
  it('parses a well-formed file into cent amounts', () => {
    const csv = [
      HEADER,
      'E001,Thandi Mokoena,25000.00,3955.42,177.12,177.12,250.00,0.00,20890.34',
      'E002,Sipho Dlamini,18000.00,2210.75,180.00,180.00,180.00,500.00,15429.25',
    ].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    const r1 = result.rows[0]!;
    expect(r1.employeeNumber).toBe('E001');
    expect(r1.employeeName).toBe('Thandi Mokoena');
    expect(r1.amounts.gross).toBe(2500000);
    expect(r1.amounts.paye).toBe(395542);
    expect(r1.amounts.uifEmployee).toBe(17712);
    expect(r1.amounts.uifEmployer).toBe(17712);
    expect(r1.amounts.sdl).toBe(25000);
    expect(r1.amounts.eti).toBe(0);
    expect(r1.amounts.net).toBe(2089034);
    expect(result.componentsPresent).toEqual(
      expect.arrayContaining(['gross', 'paye', 'uifEmployee', 'uifEmployer', 'sdl', 'eti', 'net']),
    );
  });

  it('accepts header aliases case-insensitively (VIP/Sage style)', () => {
    const csv = [
      'Employee Code;Full Name;Gross Pay;Tax;UIF;Nett Pay',
      'E001;Thandi Mokoena;25000,00;3955,42;177,12;20890,34',
    ].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.errors).toEqual([]);
    const r = result.rows[0]!;
    expect(r.employeeNumber).toBe('E001');
    expect(r.amounts.gross).toBe(2500000);
    expect(r.amounts.paye).toBe(395542);
    expect(r.amounts.uifTotal).toBe(17712);
    expect(r.amounts.net).toBe(2089034);
  });

  it('auto-detects semicolon delimiter', () => {
    const csv = [
      'employee_number;gross;paye;net',
      'E001;25000.00;3955.42;20890.34',
    ].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.amounts.gross).toBe(2500000);
  });

  it('handles quoted fields with embedded delimiters', () => {
    const csv = [
      'employee_number,employee_name,gross,paye,net',
      'E001,"Mokoena, Thandi","1,234.56",100.00,"1,134.56"',
    ].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.employeeName).toBe('Mokoena, Thandi');
    expect(result.rows[0]!.amounts.gross).toBe(123456);
  });

  it('handles CRLF line endings and skips blank lines', () => {
    const csv = 'employee_number,gross,paye,net\r\nE001,100.00,10.00,90.00\r\n\r\n';
    const result = parseExternalPayslipCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it('blank amount cells are zero', () => {
    const csv = [
      'employee_number,gross,paye,eti,net',
      'E001,100.00,10.00,,90.00',
    ].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.amounts.eti).toBe(0);
  });

  it('rejects a file without an employee number column', () => {
    const csv = ['name,gross,net', 'Thandi,100.00,90.00'].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.errors.some((e) => /employee.number/i.test(e.message))).toBe(true);
  });

  it('rejects a file without any amount column', () => {
    const csv = ['employee_number,employee_name', 'E001,Thandi'].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.errors.some((e) => /amount column/i.test(e.message))).toBe(true);
  });

  it('flags a duplicate employee number with its line number', () => {
    const csv = [
      'employee_number,gross,paye,net',
      'E001,100.00,10.00,90.00',
      'E001,200.00,20.00,180.00',
    ].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(3);
    expect(result.errors[0]!.message).toMatch(/duplicate/i);
  });

  it('flags unparseable amounts with line numbers and excludes the row', () => {
    const csv = [
      'employee_number,gross,paye,net',
      'E001,not-a-number,10.00,90.00',
      'E002,100.00,10.00,90.00',
    ].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.employeeNumber).toBe('E002');
    expect(result.errors[0]!.line).toBe(2);
  });

  it('flags a row with a missing employee number', () => {
    const csv = ['employee_number,gross,paye,net', ',100.00,10.00,90.00'].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.errors[0]!.line).toBe(2);
  });

  it('empty file yields a single error', () => {
    const result = parseExternalPayslipCsv('');
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('a truncated row (fewer cells than header) is an error, not silent zeros', () => {
    const csv = [
      'employee_number,gross,paye,net',
      'E001,25000.00,3955.42',
      'E002,100.00,10.00,90.00',
    ].join('\n');
    const result = parseExternalPayslipCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.employeeNumber).toBe('E002');
    expect(result.errors[0]!.line).toBe(2);
    expect(result.errors[0]!.message).toMatch(/column/i);
  });

  it('rejects files above the row cap', () => {
    const body = Array.from({ length: 10_001 }, (_, i) => `E${i},100.00`).join('\n');
    const result = parseExternalPayslipCsv(`employee_number,net\n${body}`);
    expect(result.rows).toEqual([]);
    expect(result.errors.some((e) => /too many rows/i.test(e.message))).toBe(true);
  });
});
