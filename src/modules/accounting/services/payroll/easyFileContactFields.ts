/**
 * The employee's addresses and bank account on the e@syFile certificate record (wave 7 EA2, W5 part 2; Hein's ruling
 * 10). Pure: the lines the record writer (easyFileExportService.employeeRecord) puts after the pay periods, from what
 * easyFileInput attached to the certificate. Nothing is written for a field the employee record does not hold, and a
 * certificate with no address or no bank account carries none of those codes (pre-validation names the employee).
 *
 * Source: SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26), section 4 "File layout". Codes and pages are
 * CERTIFICATE_FIELDS (easyFileCertificateCodes):
 *   Residential, pp. 35-36: 3211 unit AN8, 3212 complex FT26, 3213 street number AN8 (optional); 3214 street / farm
 *     FT26 (mandatory); 3215 suburb FT33 or 3216 city FT21 (one of them); 3217 postal code AN10 (ZA: four digits, not
 *     0000, written with its leading 0 as "0040"); 3285 country A2 (mandatory).
 *   Postal, pp. 37-41: 3279 care-of indicator A1 (mandatory; "If Postal Address structure indicator = 4, then value can
 *     only be N"), 3288 structure N1 (mandatory: "1 - Structured Physical Address (same as Residential Address)", "4 -
 *     Unstructured 4-line Postal Address"). Only 1 and 4 are captured (EA1); a PO Box or a different street address is
 *     held as the four lines. Structure 4 then carries 3289 line 1 FT35 (mandatory), 3290-3292 lines 2-4 FT35, 3293
 *     postal code AN10 (ZA: four digits, not 0000) and 3294 country A2 (mandatory if nature of person is not N).
 *     No care-of intermediary is captured, so 3279 is N for both structures and 3283 is never written.
 *   Bank, pp. 45-46: 3240 account type N1 (0 "Not paid by electronic bank transfer", 1 cheque / current, 2 savings,
 *     3 transmission; mandatory on every certificate), 3241 account number AN16 ("Only numeric values are allowed"),
 *     3242 branch number N6 ("All 6 characters of this field must be completed"), 3243 bank name FT50 (optional), 3245
 *     account holder FT49 and 3246 holder relationship N1 ("1. Own 2. Joint 3. Third Party"), both mandatory unless
 *     3240 is 0 or 7, and "must not be completed if code 3240 is 0". 3244 branch name is not held (optional). An
 *     employee with no account on record is 3240 = 0 alone (Hein's ruling 25). The account is checked when it is read
 *     (bankAccountForCertificate), so the writer never refuses a file over it.
 */
import { certificateField } from './easyFileCertificateCodes';
import type { EmployeeAddress } from './payrollEmployeeAddressInput';
import type { AccountType, HolderRelationship } from './payrollBankDetailsService';

/** The bank account as the certificate writes it: already checked by bankAccountForCertificate. */
export type CertificateBankAccount = { notElectronic: true } | ElectronicAccount;

/** No account on record: 3240 = 0, "Not paid by electronic bank transfer" (BRS p. 45), and no other bank field. */
export const NOT_ELECTRONIC: CertificateBankAccount = { notElectronic: true };

interface ElectronicAccount {
  notElectronic?: false;
  accountType: AccountType;
  accountNumber: string;
  branchCode: string;
  /** Null when it cannot stand in 3243 (optional): longer than 50, or a character the format refuses. */
  bankName: string | null;
  /** Null when not held or it cannot stand in 3245 (mandatory: e@syFile asks for it; the warning names the employee). */
  accountHolder: string | null;
  /** 3246; null when not stated (e@syFile asks for it; the warning names the employee). */
  holderRelationship: HolderRelationship | null;
}

/** 3240 (p. 45). 0 (not paid by electronic transfer) and 4-7 are never written: no captured account is of those types. */
const ACCOUNT_TYPE_3240: Record<AccountType, number> = { cheque: 1, savings: 2, transmission: 3 };
/** 3246 (p. 46). */
const RELATIONSHIP_3246: Record<HolderRelationship, number> = { own: 1, joint: 2, third_party: 3 };

/** A quoted value the format can carry: within its length, and no comma, pipe, double quote or control character. */
const fits = (v: string | null, max: number): string | null =>
  v !== null && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f",|]/.test(v) && !v.startsWith(' ') ? v : null;

/** The address lines, in the BRS's order; none when no address is held. */
function addressLines(a: EmployeeAddress | undefined): Array<string | null> {
  if (!a) return [];
  const r = a.residential;
  const p = a.postal;
  return [
    certificateField('residentialUnitNumber', r.unitNumber),
    certificateField('residentialComplex', r.complex),
    certificateField('residentialStreetNumber', r.streetNumber),
    certificateField('residentialStreet', r.street),
    certificateField('residentialSuburb', r.suburb),
    certificateField('residentialCity', r.city),
    certificateField('residentialPostalCode', r.postalCode),
    certificateField('residentialCountry', r.countryCode),
    certificateField('postalCareOf', 'N'),
    certificateField('postalStructure', p.sameAsResidential ? 1 : 4),
    ...(p.sameAsResidential ? [] : [
      certificateField('postalLine1', p.line1),
      certificateField('postalLine2', p.line2),
      certificateField('postalLine3', p.line3),
      certificateField('postalLine4', p.line4),
      certificateField('postalCode', p.postalCode),
      certificateField('postalCountry', p.countryCode),
    ]),
  ];
}

function bankLines(b: CertificateBankAccount | undefined): Array<string | null> {
  if (!b) return [];
  if (b.notElectronic) return [certificateField('bankAccountType', 0)]; // 3240,0 alone: 3241-3246 must not be completed
  return [
    certificateField('bankAccountType', ACCOUNT_TYPE_3240[b.accountType]),
    certificateField('bankAccountNumber', b.accountNumber),
    certificateField('bankBranchNumber', b.branchCode),
    certificateField('bankName', b.bankName),
    certificateField('bankAccountHolder', b.accountHolder),
    certificateField('bankHolderRelationship', b.holderRelationship ? RELATIONSHIP_3246[b.holderRelationship] : null),
  ];
}

/** The certificate's address and bank lines (nil fields left out, BRS §3(i)). */
export function certificateContactLines(emp: { address?: EmployeeAddress; bankAccount?: CertificateBankAccount }): string[] {
  return [...addressLines(emp.address), ...bankLines(emp.bankAccount)].filter((l): l is string => l !== null);
}

export interface BankDetailsForCertificate {
  accountType: AccountType; accountNumber: string; branchCode: string; bankName: string; accountHolder: string | null;
  accountHolderRelationship?: HolderRelationship | null;
}

/**
 * The account as the certificate can carry it, or why it cannot: an account number that is not 1-16 digits (3241) or a
 * branch code that is not six digits (3242) leaves the whole bank group off. A bank name or holder the format cannot
 * carry is left out alone (3243 optional; 3245 then asked for by e@syFile). An own account with no holder captured
 * names the employee in 3245 (`employeeName`: the relationship says the account is in their name).
 */
export function bankAccountForCertificate(
  d: BankDetailsForCertificate, employeeName = '',
): { account: ElectronicAccount } | { problem: string } {
  if (!/^[0-9]{1,16}$/.test(d.accountNumber)) return { problem: 'the account number is not 1 to 16 digits (code 3241)' };
  if (!/^[0-9]{6}$/.test(d.branchCode)) return { problem: 'the branch code is not six digits (code 3242)' };
  if (!(d.accountType in ACCOUNT_TYPE_3240)) return { problem: 'the account type is not cheque, savings or transmission (code 3240)' };
  const relationship = d.accountHolderRelationship ?? null;
  const holder = d.accountHolder?.trim() || (relationship === 'own' ? employeeName.trim() : '') || null;
  return {
    account: {
      accountType: d.accountType, accountNumber: d.accountNumber, branchCode: d.branchCode,
      bankName: fits(d.bankName.trim(), 50), accountHolder: fits(holder, 49), holderRelationship: relationship,
    },
  };
}
