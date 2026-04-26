/**
 * IRP5 Validation Engine tests.
 *
 * Migrated 2026-04-24: validateComponent / validateCompanyComponents /
 * validateEmployeeIrp5 are now async + take taxYear (codes resolved via
 * sarsCodesService against migration 435 sars_source_codes table).
 */

import { describe, it, expect, vi } from 'vitest';

// Mock @/lib/neon so sarsCodesService doesn't need a live DB.
// sql returns the in-memory SARS codes table used by all tests below.
vi.mock('@/lib/neon', () => {
  const SARS_ROWS = [
    { code: '3601', effective_year: 2026, category: 'income',    description: 'Gross salary',      status: 'active', foreign_code: null, code_pair: null, applicability_note: null, rationalisation_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: null },
    { code: '4102', effective_year: 2026, category: 'deduction', description: 'Pension fund',       status: 'active', foreign_code: null, code_pair: null, applicability_note: null, rationalisation_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: null },
    { code: '4141', effective_year: 2026, category: 'employer',  description: 'UIF contribution',   status: 'active', foreign_code: null, code_pair: null, applicability_note: null, rationalisation_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: null },
    { code: '4150', effective_year: 2026, category: 'employer',  description: 'SDL contribution',   status: 'active', foreign_code: null, code_pair: null, applicability_note: null, rationalisation_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: null },
    { code: '3901', effective_year: 2026, category: 'lump_sum',  description: 'Severance payment',  status: 'active', foreign_code: null, code_pair: null, applicability_note: null, rationalisation_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: null },
  ];
  const sqlFn = vi.fn().mockResolvedValue(SARS_ROWS);
  return {
    sql: sqlFn,
    withTransaction: vi.fn(),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

import {
  isValidSarsTaxNumber,
  isValidSaIdNumber,
  validateComponent,
  validateCompanyComponents,
  validateEmployeeIrp5,
  highestSeverity,
  type ComponentConfig,
  type EmployeeIrp5Input,
  type ValidationMessage,
} from '@/modules/accounting/services/payroll/irp5ValidationEngine';

const TAX_YEAR = 2026;

const has = (msgs: ValidationMessage[], code: string) => msgs.some((m) => m.code === code);
const find = (msgs: ValidationMessage[], code: string) => msgs.find((m) => m.code === code);

const validEmployee: EmployeeIrp5Input = {
  taxNumber: '0123456789',
  idNumber: '9001015009087',
  totalGross: 120000,
  totalPaye: 12000,
  totalUif: 1000,
  totalSdl: 1200,
  componentCodes: ['3601', '4102', '4141', '4150'],
};

// ─── helpers ─────────────────────────────────────────────────────────────────

describe('isValidSarsTaxNumber', () => {
  it.each([
    ['0123456789', true],
    ['1234567890', true],
    ['2234567890', true],
    ['3234567890', true],
    ['9234567890', true],
    ['4234567890', false],
    ['123456789', false],
    ['12345678901', false],
    ['', false],
    [null, false],
  ])('%s → %s', (v, expected) => {
    expect(isValidSarsTaxNumber(v)).toBe(expected);
  });
});

describe('isValidSaIdNumber', () => {
  it('accepts 13 digits', () => {
    expect(isValidSaIdNumber('9001015009087')).toBe(true);
  });
  it('rejects non-13-digit inputs', () => {
    expect(isValidSaIdNumber('123')).toBe(false);
    expect(isValidSaIdNumber('abc0000000000')).toBe(false);
  });
});

// ─── validateComponent ───────────────────────────────────────────────────────

describe('validateComponent', () => {
  const base: ComponentConfig = {
    id: 'c1',
    name: 'Basic Salary',
    sarsSourceCode: '3601',
    componentType: 'earning',
    isActive: true,
  };

  it('passes a well-configured earning', async () => {
    expect(await validateComponent(base, TAX_YEAR)).toEqual([]);
  });

  it('flags unknown source code', async () => {
    const out = await validateComponent({ ...base, sarsSourceCode: '9999' }, TAX_YEAR);
    expect(out).toHaveLength(1);
    expect(out[0]?.code).toBe('IRP5_UNKNOWN_CODE');
  });

  it('flags category mismatch (deduction code on earning)', async () => {
    const out = await validateComponent({ ...base, sarsSourceCode: '4102' }, TAX_YEAR);
    expect(out.length).toBeGreaterThan(0);
    expect(has(out, 'IRP5_CATEGORY_MISMATCH')).toBe(true);
  });
});

// ─── validateCompanyComponents ───────────────────────────────────────────────

describe('validateCompanyComponents', () => {
  it('returns no warnings for distinct active codes', async () => {
    const out = await validateCompanyComponents([
      { id: 'a', name: 'Salary', sarsSourceCode: '3601', componentType: 'earning', isActive: true },
      { id: 'b', name: 'PAYE',   sarsSourceCode: '4102', componentType: 'deduction', isActive: true },
    ], TAX_YEAR);
    expect(out).toEqual([]);
  });

  it('flags duplicate code across two active components', async () => {
    const out = await validateCompanyComponents([
      { id: 'a', name: 'Salary 1', sarsSourceCode: '3601', componentType: 'earning', isActive: true },
      { id: 'b', name: 'Salary 2', sarsSourceCode: '3601', componentType: 'earning', isActive: true },
    ], TAX_YEAR);
    const dupe = find(out, 'IRP5_DUPLICATE_CODE_ACROSS_COMPONENTS');
    expect(dupe).toBeDefined();
    expect(dupe?.message).toContain('Salary 1');
    expect(dupe?.message).toContain('Salary 2');
  });

  it('ignores inactive components for duplicate-code check', async () => {
    const out = await validateCompanyComponents([
      { id: 'a', name: 'Old',    sarsSourceCode: '3601', componentType: 'earning', isActive: false },
      { id: 'b', name: 'Active', sarsSourceCode: '3601', componentType: 'earning', isActive: true },
    ], TAX_YEAR);
    expect(has(out, 'IRP5_DUPLICATE_CODE_ACROSS_COMPONENTS')).toBe(false);
  });
});

// ─── validateEmployeeIrp5 ────────────────────────────────────────────────────

describe('validateEmployeeIrp5', () => {
  it('happy path → no messages', async () => {
    expect(await validateEmployeeIrp5(validEmployee, TAX_YEAR)).toEqual([]);
  });

  it('flags missing tax number', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee, taxNumber: null }, TAX_YEAR);
    expect(has(out, 'IRP5_MISSING_TAX_NUMBER')).toBe(true);
  });

  it('flags invalid tax number format', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee, taxNumber: '4444444444' }, TAX_YEAR);
    expect(has(out, 'IRP5_INVALID_TAX_NUMBER')).toBe(true);
  });

  it('downgrades ID issues to warning (passport holders)', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee, idNumber: 'A1234567' }, TAX_YEAR);
    expect(find(out, 'IRP5_INVALID_ID')?.severity).toBe('warning');
  });

  it('short-circuits downstream rules when no payroll runs exist', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee, totalGross: 0, totalPaye: 0, totalUif: 0, totalSdl: 0, componentCodes: [] }, TAX_YEAR);
    expect(has(out, 'IRP5_NO_PAYROLL')).toBe(true);
    expect(has(out, 'IRP5_PAYE_WITHOUT_INCOME_CODE')).toBe(false);
  });

  it('flags PAYE without an income code', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee, componentCodes: ['4102'] }, TAX_YEAR);
    expect(has(out, 'IRP5_PAYE_WITHOUT_INCOME_CODE')).toBe(true);
  });

  it('does not flag missing 4141/4150 (UIF/SDL are auto-calculated, never components)', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee, componentCodes: ['3601', '4102'] }, TAX_YEAR);
    expect(has(out, 'IRP5_UIF_MISSING_4141')).toBe(false);
    expect(has(out, 'IRP5_SDL_MISSING_4150')).toBe(false);
  });

  it('flags unknown codes on the employee', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee, componentCodes: ['3601', '4102', '4141', '4150', '9999'] }, TAX_YEAR);
    const hit = find(out, 'IRP5_UNKNOWN_CODE');
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('9999');
  });

  it('flags duplicate codes on the employee', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee, componentCodes: ['3601', '3601', '4102', '4141', '4150'] }, TAX_YEAR);
    expect(has(out, 'IRP5_DUPLICATE_CODE_ON_EMPLOYEE')).toBe(true);
  });

  it('flags severance (3901) without an approved directive', async () => {
    const out = await validateEmployeeIrp5({
      ...validEmployee,
      componentCodes: [...validEmployee.componentCodes, '3901'],
    }, TAX_YEAR);
    expect(has(out, 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE')).toBe(true);
    expect(find(out, 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE')?.severity).toBe('warning');
  });

  it('does not flag severance when an approved directive is present', async () => {
    const out = await validateEmployeeIrp5({
      ...validEmployee,
      componentCodes: [...validEmployee.componentCodes, '3901'],
      hasApprovedSeveranceDirective: true,
    }, TAX_YEAR);
    expect(has(out, 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE')).toBe(false);
  });

  it('does not flag severance when 3901 is not present', async () => {
    const out = await validateEmployeeIrp5({ ...validEmployee }, TAX_YEAR);
    expect(has(out, 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE')).toBe(false);
  });
});

// ─── highestSeverity ─────────────────────────────────────────────────────────

describe('highestSeverity', () => {
  it('returns null when empty', () => {
    expect(highestSeverity([])).toBeNull();
  });

  it('picks error over warning over info', () => {
    expect(highestSeverity([
      { severity: 'info', code: 'x', message: '' },
      { severity: 'warning', code: 'y', message: '' },
      { severity: 'error', code: 'z', message: '' },
    ])).toBe('error');
    expect(highestSeverity([
      { severity: 'info', code: 'x', message: '' },
      { severity: 'warning', code: 'y', message: '' },
    ])).toBe('warning');
    expect(highestSeverity([
      { severity: 'info', code: 'x', message: '' },
    ])).toBe('info');
  });
});
