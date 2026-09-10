/**
 * Does the document POSITIVELY say it is a purchase?
 *
 * The credit rule (`creditIndicators`) is a list of the ways a document says it
 * returns money, and seven review rounds have each found words it lacked
 * (`TERUGBOEKING`, `OMKERING`, `CHARGEBACK`…). A missing word there is a
 * wrong-direction post. This is the second gate, and it points the other way:
 * a document may post unattended only when its HEADER names it a purchase
 * document — a tax invoice, an invoice, a receipt, a till slip, a cash sale,
 * a `BELASTINGFAKTUUR`, a `KWITANSIE`. A credit note titled with a word the
 * credit list does not know still carries no purchase title, and refuses.
 *
 * The title list is closed and FAILS CLOSED: a purchase document titled with a
 * word missing here goes to a person. The title must be the LINE — optionally
 * with its document number (`Invoice No: 88123`, `Receipt No 004512`) — so
 * `Original Invoice No: 123` on a credit note, or `Invoice` inside prose, is
 * not a title. The header is every line above the first money figure.
 *
 * A document with no text (an image the model read) has only its model-given
 * type to go on, and passes only as an `invoice` or a `receipt`.
 */
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const TITLE = String.raw`(?:(?:TAX|VAT|BTW)\s+)?INVOICE|TAX\s+INV\.?|(?:TAX\s+)?RECEIPT|TILL\s+SLIP|SALES?\s+(?:SLIP|RECEIPT)|CASH\s+SALE|(?:BELASTING\s*)?FAKTUUR|KWITANSIE|(?:KAS|VERKOOP)?\s*STROKIE|BILL|RECEIPT\s*/\s*TAX\s+INVOICE|TAX\s+INVOICE\s*/\s*RECEIPT`;
const TITLE_LINE = new RegExp(
  String.raw`^[\s*=#-]*(?:${TITLE})(?:\s*\((?:COPY|KOPIE)\))?[\s*=#-]*$`,
  'i',
);
const MONEY_FIGURE = /\d[.,]\d{2}(?!\d)/;

export function identifiesAsPurchase(
  doc: Pick<ExtractedDocument, 'rawText' | 'documentType'>,
): boolean {
  const text = doc.rawText ?? '';
  if (text.trim().length === 0) return doc.documentType === 'invoice' || doc.documentType === 'receipt';
  const lines = text.split(/\r?\n/);
  const firstMoney = lines.findIndex((line) => MONEY_FIGURE.test(line));
  const header = firstMoney < 0 ? lines : lines.slice(0, firstMoney);
  return header.some((line) => TITLE_LINE.test(line));
}
