/**
 * Does the document POSITIVELY say it is a purchase?
 *
 * The credit rule (`creditIndicators`) is a list of the ways a document says it
 * returns money, and review after review has found words it lacked. A missing
 * word there is a wrong-direction post. This is the second gate, and it points
 * the other way: a document may post unattended only when its HEADER names it
 * a purchase document — a tax invoice, an invoice, a receipt, a till slip, a
 * cash sale, a `BELASTINGFAKTUUR`, a `KWITANSIE`. A credit note titled with a
 * word the credit list does not know carries no purchase title, and refuses.
 * (A refund printed on a TAX INVOICE template does carry one, and for that
 * the credit list is still load-bearing — see fix.md, rounds 21 and 22.)
 *
 * Two rules, and both FAIL CLOSED:
 *
 *  1. A title LINE is the title words and nothing else — optionally bilingual
 *     (`TAX INVOICE / BELASTINGFAKTUUR`), `ORIGINAL` and a page marker. A line
 *     carrying a NUMBER is a field, never a title (round 22): `Invoice No:
 *     55123` is printed by nearly every credit note, pro forma and reprint, to
 *     cite the invoice, and round 21 let it pass all of them as purchases. A
 *     purchase document titled with a word missing here goes to a person.
 *  2. Any header line naming a document that is NOT a first-time purchase
 *     refuses, title or no title (`NOT_A_PURCHASE`): a COPY, REPRINT or
 *     DUPLICATE (a reprint of a captured slip is a double post), a pro forma,
 *     quotation, estimate, delivery note, statement, order, goods-received
 *     voucher, and the credit, discount, settlement, short-delivery and claim
 *     notes a supplier sends to REDUCE an invoice. Each entry names a
 *     DOCUMENT: a bare `Discount` heads a price column on an ordinary invoice,
 *     so it counts only as `DISCOUNT NOTE`/`SLIP`/…. This list only ever
 *     refuses; the title rule is what fails closed for the word it lacks.
 *
 * The supplier's own name and address are blanked first (`Copy Shop
 * Rosebank`, `Discount Tyres`), as the credit rule does. The header is every
 * line above the first money figure, a date or a time (`10.09.26 14:32`) not
 * counting as one. A document with no text (an image the model read) passes
 * only on a model type of `invoice` or `receipt`.
 */
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { scrubVendorIdentity } from './creditIndicators';

const QUALIFIED = String.raw`(?:(?:TAX|VAT|BTW|SALES|RETAIL|TILL|CUSTOMER|CASH|PARKING)\s+)`;
const ONE_TITLE = String.raw`(?:${QUALIFIED}?(?:INVOICE|RECEIPT)|TAX\s+INV\.?|TILL\s+SLIP|SALES?\s+SLIP|CASH\s+(?:SALE|SLIP)|(?:BELASTING\s*)?FAKTUUR|KWITANSIE|(?:KAS|VERKOOP)?\s*STROKIE|BILL)`;
const TITLE_LINE = new RegExp(
  String.raw`^[\s*=#-]*${ONE_TITLE}(?:\s*[/|&-]?\s*${ONE_TITLE})*(?:\s*\(?ORIGINAL\)?)?(?:\s*Page\s+\d+\s+of\s+\d+)?[\s*=#-]*$`,
  'i',
);
const NOT_A_PURCHASE = new RegExp(String.raw`(?<![A-Za-z])(?:COPY|RE-?PRINT\w*|DUPLICAT\w*|PRO[\s-]*FORMA|QUOT(?:E|ATION)|KWOTASIE|ESTIMATE|STATEMENT|STAAT|NOTE|NOTA|ORDER\s+CONFIRMATION|PURCHASE\s+ORDER|GRV|GRN|GOODS\s+RECEIVED|DISCOUNT\s+(?:SLIP|VOUCHER|ADVICE|MEMO)|SETTLEMENT|SHORT\s+(?:DELIVER|SUPPL|SHIP)\w*|SHORTAGE|CLAIM|DAMAGES?|ADJUSTMENT|ALLOWANCE|INCENTIVE|BONUS|REBATE|SWOP|SWAP|EXCH\w*|ACCEPTED\s+BACK)(?![A-Za-z])`, 'i');
const MONEY_FIGURE = /\d[.,]\d{2}(?!\d)/;
/** A date, a time printed after a date, or a labelled time — never the first money figure. */
function stripDateTime(line: string): string {
  return line
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}[.:]\d{2}(?:[.:]\d{2})?)?\b/g, ' ')
    .replace(/(?<![A-Za-z])(?:Time|Tyd)\s*:?\s*\d{1,2}[.:]\d{2}\b/gi, ' ');
}

export function identifiesAsPurchase(
  doc: Pick<ExtractedDocument, 'rawText' | 'documentType'>
    & Partial<Pick<ExtractedDocument, 'vendorName' | 'vendorAddress'>>,
): boolean {
  const text = scrubVendorIdentity(doc.rawText ?? '', [doc.vendorName, doc.vendorAddress]);
  if (text.trim().length === 0) return doc.documentType === 'invoice' || doc.documentType === 'receipt';
  const lines = text.split(/\r?\n/);
  const firstMoney = lines.findIndex((line) => MONEY_FIGURE.test(stripDateTime(line)));
  const header = firstMoney < 0 ? lines : lines.slice(0, firstMoney);
  return header.some((line) => TITLE_LINE.test(line)) && !header.some((line) => NOT_A_PURCHASE.test(line));
}
