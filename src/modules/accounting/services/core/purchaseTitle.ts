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
 * the credit list is still load-bearing — see fix.md, round 21.)
 *
 * The title list is closed and FAILS CLOSED: a purchase document titled with a
 * word missing here goes to a person. A title LINE may be bilingual (`TAX
 * INVOICE / BELASTINGFAKTUUR`), carry `ORIGINAL`, a page marker, and its
 * document number (`TAX INVOICE No 88123`, `Invoice No: 88123`) — the number
 * on a title line is the document's, never money (`isTitleLine`). `Original
 * Invoice No: 123` on a credit note is not a title line.
 *
 * A COPY, REPRINT or DUPLICATE title is deliberately NOT a title. A reprint of
 * a slip that was already captured is the same purchase a second time, and
 * posting it unattended is a double post.
 *
 * A bare `RECEIPT` beside a GRV/GRN marking is a goods-received voucher — the
 * buyer's own document, not the supplier's — and does not count.
 *
 * The header is every line above the first money figure, a date or a time
 * (`10.09.26 14:32`) not counting as one. A document with no text (an image
 * the model read) passes only on a model type of `invoice` or `receipt`.
 */
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const QUALIFIED = String.raw`(?:(?:TAX|VAT|BTW|SALES|RETAIL|TILL|CUSTOMER|CASH|PARKING)\s+)`;
const ONE_TITLE = String.raw`(?:${QUALIFIED}?(?:INVOICE|RECEIPT)|TAX\s+INV\.?|TILL\s+SLIP|SALES?\s+SLIP|CASH\s+(?:SALE|SLIP)|(?:BELASTING\s*)?FAKTUUR|KWITANSIE|(?:KAS|VERKOOP)?\s*STROKIE|BILL|STATEMENT)`;
const TITLE_LINE = new RegExp(
  String.raw`^[\s*=#-]*${ONE_TITLE}(?:\s*[/|&-]\s*${ONE_TITLE})*(?:\s*\(?ORIGINAL\)?)?`
  + String.raw`(?:\s*(?:No|Nr|Number|#)?\.?\s*[:#]?\s*(?=[\w/-]*\d)[A-Z0-9][\w/-]*)?(?:\s*Page\s+\d+\s+of\s+\d+)?[\s*=#-]*$`,
  'i',
);
/** A title line must name a purchase, not only a statement. */
const PURCHASE_WORD = /(?<![A-Za-z])(?:INVOICE|INV\.?|RECEIPT|SLIP|SALE|(?:BELASTING\s*)?FAKTUUR|KWITANSIE|(?:KAS|VERKOOP)?STROKIE|BILL)(?![A-Za-z])/i;
const GOODS_RECEIVED = /(?<![A-Za-z])(?:GRV|GRN|GOODS\s+RECEIVED)(?![A-Za-z])/i;
const MONEY_FIGURE = /\d[.,]\d{2}(?!\d)/;
/** A date, a time printed after a date, or a labelled time — never the first money figure. */
function stripDateTime(line: string): string {
  return line
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}[.:]\d{2}(?:[.:]\d{2})?)?\b/g, ' ')
    .replace(/(?<![A-Za-z])(?:Time|Tyd)\s*:?\s*\d{1,2}[.:]\d{2}\b/gi, ' ');
}

/** Is this line a purchase title (optionally with its document number)? */
export function isTitleLine(line: string): boolean {
  return TITLE_LINE.test(line) && PURCHASE_WORD.test(line);
}

/**
 * Is the number on this title line the DOCUMENT's number rather than money?
 * Only when the line says so: a number word (`TAX INVOICE No 88123`, `#12345`),
 * a code (`INV-20931`, `004512`), or a colon after a two-word title (`TAX
 * INVOICE: 12345`). A bare `RECEIPT 1500` or `Receipt: 1500` may be an amount,
 * and is read as one.
 */
export function titleNumberIsDocument(line: string): boolean {
  if (!isTitleLine(line)) return false;
  const number = /(\S+)\s*(?:Page\s+\d+\s+of\s+\d+)?[\s*=#-]*$/i.exec(line)?.[1] ?? '';
  if (!/\d/.test(number)) return true;
  // A code is the document's only on a long number (`INV-20931`, `TAL-998877`):
  // `CASH-1500` and `CO-350` are a payment and a call-out fee.
  const digits = number.replace(/\D/g, '');
  if (/[A-Za-z]/.test(number)) return digits.length >= 5;
  if (/^0/.test(number.replace(/^[#:]/, ''))) return true;
  if (/(?:No|Nr|Number)\.?\s*[:#]?\s*\S+\s*$|#\s*\S+\s*$/i.test(line.replace(/\s*Page\s+\d+\s+of\s+\d+.*$/i, ''))) return true;
  return /^[\s*=#-]*\S+\s+\S+\s*:\s*\S+/.test(line);
}

export function identifiesAsPurchase(
  doc: Pick<ExtractedDocument, 'rawText' | 'documentType'>,
): boolean {
  const text = doc.rawText ?? '';
  if (text.trim().length === 0) return doc.documentType === 'invoice' || doc.documentType === 'receipt';
  const lines = text.split(/\r?\n/);
  const firstMoney = lines.findIndex((line) => MONEY_FIGURE.test(stripDateTime(line)));
  const header = firstMoney < 0 ? lines : lines.slice(0, firstMoney);
  const goodsReceived = header.some((line) => GOODS_RECEIVED.test(line));
  return header.some((line) => isTitleLine(line)
    && !(goodsReceived && !/INVOICE|FAKTUUR/i.test(line)));
}
