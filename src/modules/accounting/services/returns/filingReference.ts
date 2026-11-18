/**
 * The reference typed back after filing on eFiling (wave 6 EFa): SARS's payment reference number (PRN), which eFiling
 * pre-populates on the VAT201 and the EMP201. Spaces and dashes anywhere are dropped first (a PRN is often printed
 * grouped); what is left must be one PRN.
 *
 * Shape (SARS, GEN-PAYM-01-G01 Payment Rules and the Guide to Bulk and Additional Payments on eFiling): 19 characters,
 * the 10-digit tax reference, then the tax type and period. The tax reference starts with 4 for VAT and 7 for PAYE
 * (SARS registration rules). VAT201: one letter and 8 digits (a 7-digit identifier and a check digit).
 * UNVERIFIED: the letter SARS uses for each tax type and the check-digit algorithm are not on file, so any letter is
 * accepted and the check digit is not verified.
 * EMP201, UNVERIFIED: some sources give one letter and 8 digits, others two letters, the period as YYMM and 3 digits
 * (7xxxxxxxxx LC YYMM 000). Until a real EMP201 PRN confirms one, both are accepted.
 *
 * assertFilingReferenceIsTheCompanys adds the company's facts: the PRN's tax reference must be the company's own VAT
 * number or PAYE reference when a well-formed one is recorded (10 digits starting 4 or 7), and a PRN already recorded
 * on another period's return is refused. A recorded number that is not a valid SARS number cannot be judged: the filing
 * goes ahead with a named warning (PRN_NOT_CROSS_CHECKED, coordinator ruling), which the filing's audit row keeps and
 * the versions drawer shows. No number recorded at all is not warned about.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ReturnRefusal, type ReturnForm, type ReturnVersion } from './returnVersionTypes';

const PRN: Record<ReturnForm, { re: RegExp; what: string; number: 'vat_number' | 'paye_reference_number'; name: string }> = {
  VAT201: {
    re: /^4\d{9}[A-Z]\d{8}$/, what: 'your 10-digit VAT number (starting with 4), a letter and 8 digits',
    number: 'vat_number', name: 'VAT number',
  },
  EMP201: {
    re: /^7\d{9}(?:[A-Z]\d{8}|[A-Z]{2}\d{7})$/,
    what: 'your 10-digit PAYE reference (starting with 7), then a letter and 8 digits or two letters and 7 digits',
    number: 'paye_reference_number', name: 'PAYE reference',
  },
};

/** The PRN in upper case without spaces or dashes, or a 400 that says what shape is expected. */
export function parseFilingReference(form: ReturnForm, raw: string): string {
  const value = raw.replace(/[\s-]+/g, '').toUpperCase();
  const shape = PRN[form];
  if (!shape.re.test(value)) {
    throw new ReturnRefusal(400,
      `The filing reference must be the payment reference number (PRN) eFiling shows on the ${form}: 19 characters, ${shape.what}.`,
      'FILING_REFERENCE_SHAPE');
  }
  return value;
}

export const PRN_NOT_CROSS_CHECKED = 'PRN_NOT_CROSS_CHECKED';
export interface FilingWarning { code: typeof PRN_NOT_CROSS_CHECKED; message: string }

/**
 * Refuses a well-formed PRN that is not this company's (400) or already names another period's return (409). Returns
 * the warning when the company's recorded number is not a valid SARS number, so the PRN was not cross-checked.
 */
export async function assertFilingReferenceIsTheCompanys(
  companyId: string, v: ReturnVersion, prn: string,
): Promise<FilingWarning | null> {
  const shape = PRN[v.formType];
  const rows = (await sql`SELECT vat_number, paye_reference_number FROM companies WHERE id = ${companyId}::UUID`) as DbRow[];
  const recorded = rows[0]?.[shape.number];
  const text = typeof recorded === 'string' ? recorded.trim() : '';
  const digits = text.replace(/[\s-]/g, '');
  const valid = /^\d{10}$/.test(digits) && digits[0] === prn[0];
  if (valid && prn.slice(0, 10) !== digits) {
    throw new ReturnRefusal(400, `This PRN starts with ${prn.slice(0, 10)}, but the company's ${shape.name} is ${digits}. `
      + `Type the PRN eFiling shows on this company's ${v.formType}.`, 'FILING_REFERENCE_TAX_NUMBER');
  }
  const reused = (await sql`
    SELECT period_start::TEXT AS period_start, period_end::TEXT AS period_end FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND filed_reference = ${prn}
      AND (period_start, period_end) IS DISTINCT FROM (${v.periodStart}::DATE, ${v.periodEnd}::DATE)
    LIMIT 1
  `) as DbRow[];
  if (reused[0]) {
    throw new ReturnRefusal(409, `This PRN is already recorded on the return for ${String(reused[0].period_start)} to `
      + `${String(reused[0].period_end)}. Each period's return has its own PRN.`, 'FILING_REFERENCE_REUSED');
  }
  return text !== '' && !valid ? {
    code: PRN_NOT_CROSS_CHECKED,
    message: `The company ${shape.name} on file is not a valid SARS number; the PRN was not cross-checked.`,
  } : null;
}
