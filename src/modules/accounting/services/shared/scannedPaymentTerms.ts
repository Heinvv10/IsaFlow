/**
 * What a scanned document's terms text means for a bill's due date. The scan is the LOWEST-ranked terms input (below
 * the user's own pick and the supplier's confirmed terms; ap/billDueDate), and it never reads as terms it is not:
 * statement wording ("90 days after statement", "30 days EOM", "end of month") counts from the month-end, not the
 * invoice date, so it is never a netNN (it would date CFS 16 Sep + 90 = 15 Dec instead of 31 Dec). It is ignored.
 * Whole words only: "cod" is cash on delivery, not the inside of "decode" or "barcode", and `0 day` must not match inside
 * "30 days" / "60 days" / "90 days".
 */
import { ownTermsDueDate } from './paymentTerms';

const STATEMENT_WORDING = /\b(statements?|stmt|eom|month[\s-]*end|end\s+of\s+(the\s+)?month)\b/;

/** The new-bill page's own "Payment Terms" option (immediate, net30, net60, net90) the text names, or null. */
export function scannedPaymentTermsOption(text: string): string | null {
  const pt = text.toLowerCase();
  if (STATEMENT_WORDING.test(pt)) return null;
  if (/\bimmediate(ly)?\b/.test(pt) || /\bcod\b/.test(pt) || /(^|\D)0 days?\b/.test(pt)) return 'immediate';
  const days = /(^|\D)(30|60|90)(\D|$)/.exec(pt);
  return days ? `net${days[2]}` : null;
}

/** The due date a scanned terms text gives for an invoice dated `invoiceDateIso`; null when it names no usable terms. */
export function scannedTermsDueDate(invoiceDateIso: string, text: string | null | undefined): string | null {
  const option = text ? scannedPaymentTermsOption(text) : null;
  return option ? ownTermsDueDate(invoiceDateIso, option) : null;
}
