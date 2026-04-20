import { describe, it, expect } from 'vitest';

import {
  isValidSarsTaxNumber,
  isValidSaIdNumber,
  isKnownSarsCode,
  validateComponent,
  validateCompanyComponents,
  validateEmployeeIrp5,
  highestSeverity,
  type ComponentConfig,
  type EmployeeIrp5Input,
  type ValidationMessage,
} from '@/modules/accounting/services/payroll/irp5ValidationEngine';

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
    ['4234567890', false], // bad first digit
    ['123456789', false],  // too short
    ['12345678901', false], // too long
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

describe('isKnownSarsCode', () => {
  it('knows seeded codes', () => {
    expect(isKnownSarsCode('3601')).toBe(true);
    expect(isKnownSarsCode('4102')).toBe(true);
  });
  it('flags unknown', () => {
    expect(isKnownSarsCode('9999')).toBe(false);
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

  it('passes a well-configured earning', () => {
    expect(validateComponent(base)).toEqual([]);
  });

  it('flags unknown source code', () => {
    const out = validateComponent({ ...base, sarsSourceCode: '9999' });
    expect(out).toHaveLength(1);
    expect(out[0]?.code).toBe('IRP5_UNKNOWN_CODE');
  });

  it('flags category mismatch (deduction code on earning)', () => {
    const out = validateComponent({ ...base, sarsSourceCode: '4102' });
    expect(out).toHaveLength(1);
    expect(out[0]?.code).toBe('IRP5_CATEGORY_MISMATCH');
  });
});

// ─── validateCompanyComponents ───────────────────────────────────────────────

describe('validateCompanyComponents', () => {
  it('returns no warnings for distinct active codes', () => {
    const out = validateCompanyComponents([
      { id: 'a', name: 'Salary', sarsSourceCode: '3601', componentType: 'earning', isActive: true },
      { id: 'b', name: 'PAYE',   sarsSourceCode: '4102', componentType: 'deduction', isActive: true },
    ]);
    expect(out).toEqual([]);
  });

  it('flags duplicate code across two active components', () => {
    const out = validateCompanyComponents([
      { id: 'a', name: 'Salary 1', sarsSourceCode: '3601', componentType: 'earning', isActive: true },
      { id: 'b', name: 'Salary 2', sarsSourceCode: '3601', componentType: 'earning', isActive: true },
    ]);
    const dupe = find(out, 'IRP5_DUPLICATE_CODE_ACROSS_COMPONENTS');
    expect(dupe).toBeDefined();
    expect(dupe?.message).toContain('Salary 1');
    expect(dupe?.message).toContain('Salary 2');
  });

  it('ignores inactive components for duplicate-code check', () => {
    const out = validateCompanyComponents([
      { id: 'a', name: 'Old',    sarsSourceCode: '3601', componentType: 'earning', isActive: false },
      { id: 'b', name: 'Active', sarsSourceCode: '3601', componentType: 'earning', isActive: true },
    ]);
    expect(has(out, 'IRP5_DUPLICATE_CODE_ACROSS_COMPONENTS')).toBe(false);
  });
});

// ─── validateEmployeeIrp5 ────────────────────────────────────────────────────

describe('validateEmployeeIrp5', () => {
  it('happy path → no messages', () => {
    expect(validateEmployeeIrp5(validEmployee)).toEqual([]);
  });

  it('flags missing tax number', () => {
    const out = validateEmployeeIrp5({ ...validEmployee, taxNumber: null });
    expect(has(out, 'IRP5_MISSING_TAX_NUMBER')).toBe(true);
  });

  it('flags invalid tax number format', () => {
    const out = validateEmployeeIrp5({ ...validEmployee, taxNumber: '4444444444' });
    expect(has(out, 'IRP5_INVALID_TAX_NUMBER')).toBe(true);
  });

  it('downgrades ID issues to warning (passport holders)', () => {
    const out = validateEmployeeIrp5({ ...validEmployee, idNumber: 'A1234567' });
    expect(find(out, 'IRP5_INVALID_ID')?.severity).toBe('warning');
  });

  it('short-circuits downstream rules when no payroll runs exist', () => {
    const out = validateEmployeeIrp5({ ...validEmployee, totalGross: 0, totalPaye: 0, totalUif: 0, totalSdl: 0, componentCodes: [] });
    expect(has(out, 'IRP5_NO_PAYROLL')).toBe(true);
    expect(has(out, 'IRP5_PAYE_WITHOUT_INCOME_CODE')).toBe(false);
  });

  it('flags PAYE without an income code', () => {
    const out = validateEmployeeIrp5({ ...validEmployee, componentCodes: ['4102'] });
    expect(has(out, 'IRP5_PAYE_WITHOUT_INCOME_CODE')).toBe(true);
  });

  it('does not flag missing 4141/4150 (UIF/SDL are auto-calculated, never components)', () => {
    const out = validateEmployeeIrp5({ ...validEmployee, componentCodes: ['3601', '4102'] });
    expect(has(out, 'IRP5_UIF_MISSING_4141')).toBe(false);
    expect(has(out, 'IRP5_SDL_MISSING_4150')).toBe(false);
  });

  it('flags unknown codes on the employee', () => {
    const out = validateEmployeeIrp5({ ...validEmployee, componentCodes: ['3601', '4102', '4141', '4150', '9999'] });
    const hit = find(out, 'IRP5_UNKNOWN_CODE');
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('9999');
  });

  it('flags duplicate codes on the employee', () => {
    const out = validateEmployeeIrp5({ ...validEmployee, componentCodes: ['3601', '3601', '4102', '4141', '4150'] });
    expect(has(out, 'IRP5_DUPLICATE_CODE_ON_EMPLOYEE')).toBe(true);
  });

  it('flags severance (3901) without an approved directive', () => {
    const out = validateEmployeeIrp5({
      ...validEmployee,
      componentCodes: [...validEmployee.componentCodes, '3901'],
    });
    expect(has(out, 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE')).toBe(true);
    expect(find(out, 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE')?.severity).toBe('warning');
  });

  it('does not flag severance when an approved directive is present', () => {
    const out = validateEmployeeIrp5({
      ...validEmployee,
      componentCodes: [...validEmployee.componentCodes, '3901'],
      hasApprovedSeveranceDirective: true,
    });
    expect(has(out, 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE')).toBe(false);
  });

  it('does not flag severance when 3901 is not present', () => {
    const out = validateEmployeeIrp5({ ...validEmployee });
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
