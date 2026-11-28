/**
 * Wave 7 EA2 (Hein's ruling 25): the EMP501 filing file's bank accounts are written at download into the stored file's
 * bytes. The served file must be byte for byte the file the record writer builds with the account on the certificate,
 * for every address shape, and touch nothing else (an H certificate, a certificate not in the map, one that already
 * carries 3240).
 */
import { describe, expect, it } from 'vitest';
import { buildIrp5File, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { bankAccountForCertificate, NOT_ELECTRONIC, type CertificateBankAccount } from '@/modules/accounting/services/payroll/easyFileContactFields';
import { overlayBankAccounts } from '@/modules/accounting/services/payroll/easyFileBankOverlay';
import type { EmployeeAddress } from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';

const employer: EmployerInput = {
  tradingName: 'Marneweck Holdings', payeReferenceNumber: '7123456789', sdlReferenceNumber: null, uifReferenceNumber: null,
  contactFirstName: 'Jane', contactSurname: 'Horn', contactBusinessPhone: '0118765432', contactCellPhone: null, contactEmail: null,
  transactionYear: 2026, reconciliationPeriod: 202602, sic7Code: '69201', physicalStreet: '12 Main Road', physicalSuburb: null,
  physicalCity: 'Johannesburg', physicalPostalCode: '2196',
};
const base = (n: number, idNumber: string): EmployeeInput => ({
  certificateNumber: `71234567892026020000000000000${n}`, yearOfAssessment: 2026, surname: `Emp${n}`, firstNames: 'Test',
  initials: 'T', idNumber, taxNumber: '0123456789', taxPeriodStart: '20250301', taxPeriodEnd: '20260228',
  payPeriodsInYear: 12, payPeriodsWorked: 12, grossSalary3601: 240_000, paye4102: 18_000, uifEmployee: 1_000, uifEmployer: 1_000, sdl4142: 2_400,
});
const same: EmployeeAddress = {
  residential: { unitNumber: null, complex: null, streetNumber: '12', street: 'Main Road', suburb: 'Hatfield', city: null, postalCode: '0028', countryCode: 'ZA' },
  postal: { sameAsResidential: true },
};
const lines4: EmployeeAddress = {
  residential: same.residential,
  postal: { sameAsResidential: false, line1: 'PO Box 1', line2: null, line3: null, line4: null, postalCode: '0011', countryCode: 'ZA' },
};
const account = bankAccountForCertificate({
  accountType: 'savings', accountNumber: '62123456789', branchCode: '051001', bankName: 'FNB', accountHolder: 'T Emp', accountHolderRelationship: 'own',
}).account as CertificateBankAccount;

const employees = [
  { ...base(1, '8001015009087'), address: same },
  { ...base(2, '8001015009186'), address: lines4 },
  base(3, '8001015009285'),
];
const accounts: CertificateBankAccount[] = [account, NOT_ELECTRONIC, account];
const file = (withBank: boolean) => buildIrp5File({
  employer, filingDate: 'warn',
  employees: employees.map((e, i) => (withBank ? { ...e, bankAccount: accounts[i]! } : e)),
});

describe('overlayBankAccounts', () => {
  it('the stored file + the accounts read at download = the file built with them, byte for byte (structures 1, 4, none)', () => {
    const map = new Map(employees.map((e, i) => [e.certificateNumber, accounts[i]!]));
    expect(overlayBankAccounts(file(false), map)).toBe(file(true));
  });

  it('a certificate not in the map is left as it is', () => {
    const map = new Map([[employees[0]!.certificateNumber, accounts[0]!]]);
    const out = overlayBankAccounts(file(false), map).split('\r\n');
    expect(out.filter((l) => l.startsWith('3240,'))).toEqual(['3240,2']);
  });

  it('a certificate already carrying 3240 gets no second set', () => {
    const map = new Map(employees.map((e, i) => [e.certificateNumber, accounts[i]!]));
    expect(overlayBankAccounts(file(true), map)).toBe(file(true));
  });
});
