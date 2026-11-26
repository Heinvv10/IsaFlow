/**
 * The e@syFile certificate record's identity and period fields: ONE map of code, BRS type and page, used by the
 * employee record writer (easyFileExportService.buildEmployeeRecord) and its checks (easyFileEmployeeChecks), and
 * for any other certificate built on the same layout (the PSP "H" certificate reuses it).
 *
 * Source: SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26), section 4 "File layout", Employee Information and
 * Employee Pay Periods; the same codes in V22.1.2 and V23.0.0. Before this map the writer put the income tax reference
 * under 3150 (the employee's work postal code), the employment dates under 3200 / 3210 (pay periods in the year and
 * pay periods worked) and the months worked under 3215 (residential suburb / district).
 *
 * Amounts (36xx-39xx, 4xxx) keep their codes where they are written: their meaning was checked against the same BRS
 * (pages 80-109) and is unchanged.
 */
import { formatField, type FieldType } from './easyFileFields';

export interface CertificateFieldSpec {
  code: number;
  /** BRS length column: A / AN / FT are quoted; N is unquoted (ND keeps every digit; N4DP has 4 decimals). */
  type: FieldType;
  /** BRS V25.3.0 page of the field's row. */
  brsPage: number;
}

export const CERTIFICATE_FIELDS = {
  certificateNumber: { code: 3010, type: 'AN', brsPage: 16 },      // AN30
  certificateType: { code: 3015, type: 'AN', brsPage: 17 },        // AN6: IRP5 / IT3(a)
  natureOfPerson: { code: 3020, type: 'A', brsPage: 17 },          // A1
  yearOfAssessment: { code: 3025, type: 'N', brsPage: 18 },        // N4 CCYY
  surname: { code: 3030, type: 'FT', brsPage: 20 },                // FT120
  firstTwoNames: { code: 3040, type: 'AN', brsPage: 20 },          // AN90
  initials: { code: 3050, type: 'A', brsPage: 20 },                // A5
  identityNumber: { code: 3060, type: 'ND', brsPage: 20 },         // N13: a leading 0 (born 2000-2009) is kept
  dateOfBirth: { code: 3080, type: 'N', brsPage: 26 },             // N8 CCYYMMDD
  incomeTaxReference: { code: 3100, type: 'ND', brsPage: 26 },     // N10: starts with 0-3 for nature A
  taxPeriodStart: { code: 3170, type: 'N', brsPage: 32 },          // N8 CCYYMMDD, mandatory
  taxPeriodEnd: { code: 3180, type: 'N', brsPage: 32 },            // N8 CCYYMMDD, mandatory
  payPeriodsInYear: { code: 3200, type: 'N4DP', brsPage: 33 },     // N3.4, mandatory
  payPeriodsWorked: { code: 3210, type: 'N4DP', brsPage: 33 },     // N3.4, mandatory, <= 3200
  // Nature of person H (wave 6 PSP-H): the company / CC (1) or trust (2) registration number of the PSP.
  alternateIdType: { code: 3065, type: 'N', brsPage: 23 },         // N1: 1 company/CC, 2 trust, 3 asylum, 4 ID, 5 passport
  alternateIdNumber: { code: 3066, type: 'FT', brsPage: 24 },      // FT30: type 1 CCYY/NNNNNN/NN
  // Wave 7 EA2: the employee's addresses (captured by EA1, migration 1056) and bank account (payroll_bank_details).
  residentialUnitNumber: { code: 3211, type: 'AN', brsPage: 35 },  // AN8, optional
  residentialComplex: { code: 3212, type: 'FT', brsPage: 35 },     // FT26, optional
  residentialStreetNumber: { code: 3213, type: 'AN', brsPage: 35 }, // AN8, optional
  residentialStreet: { code: 3214, type: 'FT', brsPage: 35 },      // FT26, mandatory: street / name of farm
  residentialSuburb: { code: 3215, type: 'FT', brsPage: 35 },      // FT33: 3215 or 3216
  residentialCity: { code: 3216, type: 'FT', brsPage: 35 },        // FT21: 3215 or 3216
  residentialPostalCode: { code: 3217, type: 'AN', brsPage: 35 },  // AN10: ZA = 4 digits, not 0000
  residentialCountry: { code: 3285, type: 'A', brsPage: 36 },      // A2, mandatory
  postalCareOf: { code: 3279, type: 'A', brsPage: 37 },            // A1, mandatory: Y / N; N only for structure 4
  postalStructure: { code: 3288, type: 'N', brsPage: 37 },         // N1, mandatory: 1 same as residential, 4 unstructured
  postalLine1: { code: 3289, type: 'FT', brsPage: 40 },            // FT35, mandatory for structure 4
  postalLine2: { code: 3290, type: 'FT', brsPage: 40 },            // FT35, optional
  postalLine3: { code: 3291, type: 'FT', brsPage: 40 },            // FT35, optional
  postalLine4: { code: 3292, type: 'FT', brsPage: 40 },            // FT35, optional
  postalCode: { code: 3293, type: 'AN', brsPage: 40 },             // AN10: ZA = 4 digits, not 0000
  postalCountry: { code: 3294, type: 'A', brsPage: 41 },           // A2, mandatory for nature of person A
  bankAccountType: { code: 3240, type: 'N', brsPage: 45 },         // N1, mandatory: 1 cheque, 2 savings, 3 transmission
  bankAccountNumber: { code: 3241, type: 'AN', brsPage: 46 },      // AN16, numeric only
  bankBranchNumber: { code: 3242, type: 'ND', brsPage: 46 },       // N6, all six digits (a leading 0 is kept)
  bankName: { code: 3243, type: 'FT', brsPage: 46 },               // FT50, optional
  bankAccountHolder: { code: 3245, type: 'FT', brsPage: 46 },      // FT49, mandatory when 3240 is not 0 or 7
  bankHolderRelationship: { code: 3246, type: 'N', brsPage: 46 },  // N1: 1 own, 2 joint, 3 third party (ruling 26, mig 1062)
} as const satisfies Record<string, CertificateFieldSpec>;

export type CertificateFieldName = keyof typeof CERTIFICATE_FIELDS;

/** One "code,value" line of the certificate record, or null for an empty value (BRS §3(i): a nil field is left out). */
export function certificateField(name: CertificateFieldName, value: string | number | null): string | null {
  const spec = CERTIFICATE_FIELDS[name];
  return formatField(spec.code, value, spec.type);
}

/** "Income tax reference number (code 3100)": the field's name and code for a refusal message. */
export function fieldLabel(name: CertificateFieldName, words: string): string {
  return `${words} (code ${CERTIFICATE_FIELDS[name].code})`;
}

/**
 * NAMED LIMITS: fields the BRS V25.3.0 makes mandatory (or conditional and met) on an IRP5 / IT3(a) of nature A that
 * this file never writes, because IsaFlow does not hold their data. e@syFile's import validation reports each one;
 * they are captured there before submission. UNVERIFIED that e@syFile accepts the import with them absent.
 *   3026 ETI indicator (p. 19-20): Y or N for an employer that qualifies for ETI; the ETI fields are out of scope.
 *   3195 voluntary over-deduction indicator and 3220 fixed-rate indicator (p. 33-34): mandatory on an IRP5 from 2020.
 *   3263 employee SIC7 (p. 27); 3136 employee business telephone (p. 28).
 *   3147-3151 the address where the employee mainly works (p. 30-31).
 * Written since wave 7 EA2 when the employee record holds them (easyFileContactFields): the residential address
 * (3211-3217, 3285), the postal address (3279, 3288, 3289-3294) and the bank account (3240-3243, 3245, 3246; read live
 * for an owner or admin in their own session, in the export and the EMP501 filing file: easyFileBankAccounts; an
 * employee with no account is 3240 = 0, not paid by electronic transfer). Pre-validation names each employee missing one.
 */
export const UNWRITTEN_MANDATORY_CODES = [3026, 3136, 3147, 3148, 3149, 3150, 3151, 3195, 3220, 3263] as const;

const NEVER_HELD = 'business phone, work address, SIC7, and the 3026 / 3195 / 3220 indicators';
const NOTICE_END = 'capture them in e@syFile before you submit.';

/**
 * Said on every e@syFile file (Hein 2026-11-20: warn, never refuse): what e@syFile will ask for because this file cannot
 * carry it. This one when the addresses were written and the bank accounts were not (the EMP501 version files, a
 * manager's export).
 */
export const UNWRITTEN_FIELDS_WARNING = 'e@syFile will ask for fields this file does not carry: employee bank details '
  + '(3240-3246: written only when an owner or admin downloads the file), any employee address not captured in IsaFlow '
  + `(IRP5 pre-validation names them), ${NEVER_HELD}: ${NOTICE_END}`;

/** The same notice for a file that carries every captured address and bank account (an owner's or admin's export). */
export const UNWRITTEN_FIELDS_WARNING_BANK_WRITTEN = 'e@syFile will ask for fields this file does not carry: any employee '
  + 'address not captured in IsaFlow (IRP5 pre-validation names them; an employee with no bank account is filed as not '
  + `paid by electronic transfer, 3240 = 0), ${NEVER_HELD}: ${NOTICE_END}`;

/** The same notice for an export by Login-as, a token or a job: no address and no bank account is written. */
export const UNWRITTEN_FIELDS_WARNING_NO_CONTACTS = 'e@syFile will ask for fields this file does not carry: employee '
  + 'addresses and bank details (3211-3294, 3240-3246: written only when a person exports in their own session), '
  + `${NEVER_HELD}: ${NOTICE_END}`;
