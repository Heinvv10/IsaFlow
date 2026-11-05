/**
 * What a scanned document's terms text means for a bill's due date. The scan is the LOWEST-ranked terms input (below
 * the user's own pick and the supplier's confirmed terms; ap/billDueDate), and it never reads as terms it is not:
 * statement wording ("90 days after statement", "30 days EOM", "30 days from end of next month", shared/paymentTerms
 * STATEMENT_WORDING) counts from the month-end, not the invoice date, so it is never a netNN (it would date CFS
 * 16 Sep + 90 = 15 Dec instead of 31 Dec). It is ignored.
 * Whole words only: "cod" is cash on delivery, not the inside of "decode" or "barcode"; "net" is not the end of
 * "Internet"; and an explicit "N days" counts only beside words a terms line uses ("Payable within 90 days"), so
 * "Internet 7 days" is not terms.
 */
import { STATEMENT_WORDING, ownTermsDueDate } from './paymentTerms';

/** Words that may stand beside "N days" in a terms line. */
const TERMS_WORDS = new Set(['net', 'nett', 'days', 'day', 'from', 'after', 'within', 'of', 'the', 'in', 'invoice', 'date', 'payable',
  'due', 'pay', 'payment', 'terms', 'strictly', 'only', 'and', 'to']);

/** The terms the text names as a bill's own-terms string ('immediate' or 'netN', N up to 999), or null. */
export function scannedPaymentTermsOption(text: string): string | null {
  const pt = text.toLowerCase();
  if (STATEMENT_WORDING.test(pt)) return null;
  if (/\bimmediate(ly)?\b/.test(pt) || /\bcod\b/.test(pt)) return 'immediate';
  const net = /\bnet\s*(\d{1,3})\b/.exec(pt);
  const explicit = /(^|\D)(\d{1,3})\s*days?\b/.exec(pt);
  const days = net ? net[1] : explicit && (pt.replace(explicit[0], ' ').match(/[a-z]+/g) ?? []).every((w) => TERMS_WORDS.has(w)) ? explicit[2] : null;
  if (days === null || days === undefined) return null;
  return Number(days) === 0 ? 'immediate' : `net${Number(days)}`;
}

/** The due date a scanned terms text gives for an invoice dated `invoiceDateIso`; null when it names no usable terms. */
export function scannedTermsDueDate(invoiceDateIso: string, text: string | null | undefined): string | null {
  const option = text ? scannedPaymentTermsOption(text) : null;
  return option ? ownTermsDueDate(invoiceDateIso, option) : null;
}
