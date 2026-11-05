/**
 * What a scanned document's terms text means for a bill's due date. The scan is the LOWEST-ranked terms input (below
 * the user's own pick and the supplier's confirmed terms; ap/billDueDate), and it never reads as terms it is not:
 * statement wording ("90 days after statement", "30 days EOM", "Net 30 E.O.M.", "30 days from end of next month",
 * shared/paymentTerms STATEMENT_WORDING) counts from the month-end, not the invoice date, so it is never a netNN (it would
 * date CFS 16 Sep + 90 = 15 Dec instead of 31 Dec). It is ignored.
 * Read: "Net 30", "Nett 30", "30 days", "30-day", "Payable within 90 days", and immediate (COD, C.O.D., due on receipt).
 * Not read: a text with MORE THAN ONE day count ("50% in 30 days and 50% in 60 days"), any other number ("Net 30, 2%
 * discount"), a decimal ("Net 150.00" is an amount), or other words beside the count ("Net 30 after delivery", "Internet
 * 7 days"): the same word check for "net N" as for "N days". Whole words only: "cod" is not the inside of "barcode".
 */
import { STATEMENT_WORDING, ownTermsDueDate } from './paymentTerms';

/** Words that may stand beside the day count in a terms line. */
const TERMS_WORDS = new Set(['net', 'nett', 'days', 'day', 'from', 'after', 'within', 'of', 'the', 'in', 'invoice', 'date', 'payable',
  'due', 'pay', 'payment', 'terms', 'strictly', 'only', 'and', 'to']);
const IMMEDIATE = /\b(immediate(ly)?|cod|cash on delivery|(due |payable )?(on|upon) receipt)\b/;
/** The number of a "net N" / "nett N" / "N days" / "N-day" phrase (up to 3 digits, never part of a decimal or a longer number). */
const DAY_COUNTS = [/\bnett?\s*(\d{1,3})(?![\d]|[.,]\d)/g, /(?<![\d.,])(\d{1,3})[\s-]*days?\b/g];

/** Dotted abbreviations without the dots: "c.o.d." -> "cod", "e.o.m." -> "eom". */
const undotted = (s: string) => s.replace(/(?<![a-z])(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ''));

/** The terms the text names as a bill's own-terms string ('immediate' or 'netN', N up to 999), or null. */
export function scannedPaymentTermsOption(text: string): string | null {
  const pt = undotted(text.toLowerCase());
  if (STATEMENT_WORDING.test(text) || STATEMENT_WORDING.test(pt)) return null;
  if (IMMEDIATE.test(pt)) return 'immediate';
  const counts = new Map<number, string>(); // index of the digits -> the digits: one phrase found by two patterns counts once
  for (const re of DAY_COUNTS) for (const m of pt.matchAll(re)) counts.set(m.index + m[0].indexOf(m[1]!), m[1]!);
  if (counts.size !== 1) return null;
  const [at, digits] = [...counts][0]!;
  const rest = pt.slice(0, at) + ' ' + pt.slice(at + digits.length);
  if (/\d/.test(rest) || !(rest.match(/[a-z]+/g) ?? []).every((w) => TERMS_WORDS.has(w))) return null;
  return Number(digits) === 0 ? 'immediate' : `net${Number(digits)}`;
}

/** The due date a scanned terms text gives for an invoice dated `invoiceDateIso`; null when it names no usable terms. */
export function scannedTermsDueDate(invoiceDateIso: string, text: string | null | undefined): string | null {
  const option = text ? scannedPaymentTermsOption(text) : null;
  return option ? ownTermsDueDate(invoiceDateIso, option) : null;
}
