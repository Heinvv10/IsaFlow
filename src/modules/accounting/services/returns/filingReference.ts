/**
 * The reference typed back after filing on eFiling (wave 6 EFa): SARS's payment reference number (PRN), which eFiling
 * pre-populates on the VAT201 and the EMP201. Structurally strict: the whole input is one PRN, spaces at the ends only.
 *
 * Shape (SARS, GEN-PAYM-01-G01 Payment Rules and the Guide to Bulk and Additional Payments on eFiling): 19 characters,
 * the 10-digit tax reference, one tax-type letter, then 8 characters (a 7-digit identifier and a check digit), e.g.
 * 1234567899T00000000. The tax reference starts with 4 for VAT and 7 for PAYE (SARS registration rules).
 * UNVERIFIED: the letter SARS uses for each tax type and the check-digit algorithm are not on file, so any letter is
 * accepted and the check digit is not verified.
 */
import { ReturnRefusal, type ReturnForm } from './returnVersionTypes';

const PRN: Record<ReturnForm, { re: RegExp; what: string }> = {
  VAT201: { re: /^4\d{9}[A-Z]\d{8}$/, what: 'your 10-digit VAT number (starting with 4), a letter and 8 digits' },
  EMP201: { re: /^7\d{9}[A-Z]\d{8}$/, what: 'your 10-digit PAYE reference (starting with 7), a letter and 8 digits' },
  // EMP501 (wave 6 EFb): the e@syFile / eFiling submission reference. UNVERIFIED: SARS publishes no shape for it, so
  // letters and digits only, 6 to 30 of them (no spaces or punctuation inside).
  EMP501: { re: /^[A-Z0-9]{6,30}$/, what: '6 to 30 letters and digits, the submission reference e@syFile or eFiling gave you' },
};

/** The PRN in upper case, or a 400 that says what shape is expected. */
export function parseFilingReference(form: ReturnForm, raw: string): string {
  const value = raw.trim().toUpperCase();
  const shape = PRN[form];
  if (!shape.re.test(value)) {
    throw new ReturnRefusal(400,
      form === 'EMP501'
        ? `The EMP501 filing reference must be ${shape.what}.`
        : `The filing reference must be the payment reference number (PRN) eFiling shows on the ${form}: 19 characters, ${shape.what}.`,
      'FILING_REFERENCE_SHAPE');
  }
  return value;
}
