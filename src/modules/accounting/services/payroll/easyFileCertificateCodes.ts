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
 * this file does not write, because IsaFlow does not hold their data. e@syFile's import validation reports each one;
 * they are captured there before submission. UNVERIFIED that e@syFile accepts the import with them absent.
 *   3026 ETI indicator (p. 19-20): Y or N for an employer that qualifies for ETI; the ETI fields are out of scope.
 *   3195 voluntary over-deduction indicator and 3220 fixed-rate indicator (p. 33-34): mandatory on an IRP5 from 2020.
 *   3263 employee SIC7 (p. 27); 3136 employee business telephone (p. 28).
 *   3147-3151 the address where the employee mainly works (p. 30-31).
 *   3214-3217, 3285 residential address; 3279, 3288 and the postal address fields (p. 35-41).
 *   3240-3246 employee bank account details (p. 45-46).
 */
export const UNWRITTEN_MANDATORY_CODES = [
  3026, 3136, 3147, 3148, 3149, 3150, 3151, 3195, 3214, 3215, 3216, 3217, 3220, 3240, 3263, 3279, 3285, 3288,
] as const;
