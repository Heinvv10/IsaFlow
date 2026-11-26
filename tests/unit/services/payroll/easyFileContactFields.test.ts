/**
 * Wave 7 EA2 (W5 part 2): the employee's addresses and bank account on the e@syFile certificate record, each code
 * pinned to its row in the SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26), pp. 35-46. The record lines are a
 * byte fixture: the exact text e@syFile imports, written out by hand from the BRS rows.
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { CERTIFICATE_FIELDS, UNWRITTEN_MANDATORY_CODES } from '@/modules/accounting/services/payroll/easyFileCertificateCodes';
import { bankAccountForCertificate, certificateContactLines } from '@/modules/accounting/services/payroll/easyFileContactFields';
import type { EmployeeAddress } from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';

const employee: EmployeeInput = {
  certificateNumber: '712345678920260200000000000001', yearOfAssessment: 2026, surname: 'Molefe', firstNames: 'Thandi',
  initials: 'T', idNumber: '0001015009087', taxNumber: '0123456789',
  taxPeriodStart: '20250301', taxPeriodEnd: '20260228', payPeriodsInYear: 12, payPeriodsWorked: 12,
  grossSalary3601: 240_000, paye4102: 18_000, uifEmployee: 1_000, uifEmployer: 1_000, sdl4142: 2_400,
};

const sameAddress: EmployeeAddress = {
  residential: {
    unitNumber: '4', complex: 'Oak Court', streetNumber: '12', street: 'Main Road', suburb: 'Hatfield', city: 'Pretoria',
    postalCode: '0028', countryCode: 'ZA',
  },
  postal: { sameAsResidential: true },
};
const boxAddress: EmployeeAddress = {
  residential: { ...sameAddress.residential, unitNumber: null, complex: null, streetNumber: null, suburb: null },
  postal: { sameAsResidential: false, line1: 'PO Box 1234', line2: 'Brooklyn', line3: null, line4: null, postalCode: '0011', countryCode: 'ZA' },
};
const bank = { accountType: 'savings' as const, accountNumber: '62123456789', branchCode: '051001', bankName: 'Standard Bank', accountHolder: 'T Molefe' };

/** The record from 3210 (pay periods worked) up to the first income or directive code: the slice EA2 writes into. */
const contactSlice = (lines: string[]) => {
  const from = lines.findIndex((l) => l.startsWith('3210,'));
  const to = lines.findIndex((l, i) => i > from && /^(3230|36\d\d),/.test(l));
  return lines.slice(from + 1, to);
};

describe('address and bank codes (BRS V25.3.0)', () => {
  it.each([
    ['residentialUnitNumber', 3211, 35], ['residentialComplex', 3212, 35], ['residentialStreetNumber', 3213, 35],
    ['residentialStreet', 3214, 35], ['residentialSuburb', 3215, 35], ['residentialCity', 3216, 35],
    ['residentialPostalCode', 3217, 35], ['residentialCountry', 3285, 36], ['postalCareOf', 3279, 37],
    ['postalStructure', 3288, 37], ['postalLine1', 3289, 40], ['postalLine2', 3290, 40], ['postalLine3', 3291, 40],
    ['postalLine4', 3292, 40], ['postalCode', 3293, 40], ['postalCountry', 3294, 41],
    ['bankAccountType', 3240, 45], ['bankAccountNumber', 3241, 46], ['bankBranchNumber', 3242, 46],
    ['bankName', 3243, 46], ['bankAccountHolder', 3245, 46],
  ] as const)('%s is code %i (p. %i)', (name, code, page) => {
    expect(CERTIFICATE_FIELDS[name]).toMatchObject({ code, brsPage: page });
  });

  it('byte fixture: structure 1 (postal = residential) and a savings account', () => {
    const lines = buildEmployeeRecord({ ...employee, address: sameAddress, bankAccount: bankAccountForCertificate(bank).account });
    expect(contactSlice(lines)).toEqual([
      '3211,"4"', '3212,"Oak Court"', '3213,"12"', '3214,"Main Road"', '3215,"Hatfield"', '3216,"Pretoria"',
      '3217,"0028"', '3285,"ZA"', '3279,"N"', '3288,1',
      '3240,2', '3241,"62123456789"', '3242,051001', '3243,"Standard Bank"', '3245,"T Molefe"',
    ]);
  });

  it('byte fixture: structure 4 (four lines), optional residential fields left out, a cheque account with no holder', () => {
    const cheque = bankAccountForCertificate({ ...bank, accountType: 'cheque', accountHolder: null }).account;
    const lines = buildEmployeeRecord({ ...employee, address: boxAddress, bankAccount: cheque });
    expect(contactSlice(lines)).toEqual([
      '3214,"Main Road"', '3216,"Pretoria"', '3217,"0028"', '3285,"ZA"', '3279,"N"', '3288,4',
      '3289,"PO Box 1234"', '3290,"Brooklyn"', '3293,"0011"', '3294,"ZA"',
      '3240,1', '3241,"62123456789"', '3242,051001', '3243,"Standard Bank"',
    ]);
  });

  it('a transmission account is 3240 = 3', () => {
    const t = bankAccountForCertificate({ ...bank, accountType: 'transmission' }).account;
    expect(certificateContactLines({ bankAccount: t })[0]).toBe('3240,3');
  });

  it('nothing captured: no address or bank code at all, and never a code IsaFlow does not hold', () => {
    const lines = buildEmployeeRecord(employee);
    expect(contactSlice(lines)).toEqual([]);
    const withAll = buildEmployeeRecord({ ...employee, address: boxAddress, bankAccount: bankAccountForCertificate(bank).account });
    for (const code of [...UNWRITTEN_MANDATORY_CODES, 3244, 3283]) {
      expect(withAll.some((l) => l.startsWith(`${code},`)), String(code)).toBe(false);
    }
  });
});

describe('bankAccountForCertificate (3241-3245 rules, p. 46)', () => {
  it('refuses an account number that is not 1-16 digits and a branch code that is not six digits', () => {
    expect(bankAccountForCertificate({ ...bank, accountNumber: '6212-345' })).toEqual({ problem: expect.stringContaining('3241') });
    expect(bankAccountForCertificate({ ...bank, accountNumber: '12345678901234567' })).toEqual({ problem: expect.stringContaining('3241') });
    expect(bankAccountForCertificate({ ...bank, branchCode: '51001' })).toEqual({ problem: expect.stringContaining('3242') });
  });

  it('leaves out a bank name (FT50) or holder (FT49) the format cannot carry, keeps the rest', () => {
    const a = bankAccountForCertificate({ ...bank, bankName: 'Bank, Ltd', accountHolder: 'x'.repeat(50) });
    expect(a).toEqual({ account: expect.objectContaining({ bankName: null, accountHolder: null, accountNumber: '62123456789' }) });
    expect(bankAccountForCertificate({ ...bank, bankName: 'b'.repeat(51) })).toEqual({ account: expect.objectContaining({ bankName: null }) });
    expect(bankAccountForCertificate({ ...bank, accountHolder: 'y'.repeat(49) })).toEqual({ account: expect.objectContaining({ accountHolder: 'y'.repeat(49) }) });
  });
});
