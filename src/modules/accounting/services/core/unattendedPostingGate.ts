/**
 * May a captured document be posted with nobody looking at it?
 *
 * This is a different question from "what is the payable total", and K-076
 * spent four rounds answering the second one in its place. Each round tried to
 * PICK the payable out of several totals printed on one slip — a denylist of
 * section nouns, then "the figure `subtotal + VAT` endorses", then "only the
 * bottom figure may be endorsed" — and each rule was beaten by a slip nobody
 * had pointed it at: a section total above the payable, a gratuity below the
 * endorsed figure, and finally a VAT-analysis block printed UNDER the tender,
 * whose own `Sub Total + VAT = Total` covers only the standard-rated part of a
 * mixed basket (measured: R230.00 posted unattended against a payable of
 * R253.00, where master read R253.00). Free OCR text is genuinely ambiguous, so
 * no picking rule can be finished.
 *
 * It does not have to be. A refusal costs a person a few seconds on the capture
 * screen; a wrong post costs money silently. So the reader still offers a best
 * guess (`selectTotalAmount`), and THIS gate decides, and it accepts only a
 * document that leaves nothing to choose between: one printed total, a VAT
 * figure, and — where a net is printed — a net and VAT that add up to it. Do
 * not add a rule here that makes one of several candidates postable; that is
 * the move that failed four times.
 *
 * The candidates are re-read from `rawText` rather than trusted from the stored
 * warnings, so a document extracted by an earlier build, or by the VLM, is
 * judged by the same rule. A document with NO text to re-read (a photo the VLM
 * read directly) cannot show that it is unambiguous, and is refused.
 */
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { detectDocumentType, extractAmounts } from './ocrExtractionService';
import { extractTotalCandidates, isUnreconciled } from './ocrAmountReconciliation';
import type { Unreconciled } from './ocrLargerFigure';
import { adjustmentAfterTotal, unexplainedLargerFigure, unreconciledFigure } from './ocrLargerFigure';
import { hasCreditIndicator } from './creditIndicators';

export type UnattendedPostingInput = Pick<
  ExtractedDocument,
  'documentType' | 'rawText' | 'subtotal' | 'vatAmount' | 'totalAmount' | 'warnings' | 'extractionMethod'
> & Partial<Pick<ExtractedDocument, 'vendorName' | 'vendorAddress'>>;

/**
 * Were the figures recovered by the regex/OCR FALLBACK rather than the
 * structured VLM extraction?
 *
 * POLICY (K-072 round 14, recorded in fix.md): fallback figures never post and
 * never approve with nobody looking, on any path. Five review rounds each beat
 * the "is this free text unambiguous" classifier with a realistic slip; the
 * fallback runs only when the VLM fails, so the cost is those documents going
 * to a person. It still offers its best guess for that person to confirm.
 * Anything but `'vlm'` — including a stored extraction with no method at all —
 * is treated as fallback.
 */
export function isFallbackExtraction(doc: Pick<ExtractedDocument, 'extractionMethod'>): boolean {
  return doc.extractionMethod !== 'vlm';
}

/**
 * A credit note, refund or return, by its classification, its sign OR its text.
 *
 * Every posting path this gate serves books a PURCHASE, so a refund read with
 * positive figures — the usual credit-note layout, and `Total 115.00-` or
 * `-R115.00`, which the amount grammar reads positive — posted EXP / VAT-in /
 * bank credit, the direction of the entry reversed. `detectDocumentType`
 * answered `credit_note` on every one of them and nothing consulted it. The
 * text is read as well as the stored field because the VLM classifies on its
 * own and a stored extraction predates any later change to either. The other
 * spellings — `REFUND`, `RETURN SLIP`, `KREDIETNOTA`, a trailing-minus total —
 * are `hasCreditIndicator`'s, and a negative total is a credit whatever read it.
 */
export function isCreditNote(
  doc: Pick<ExtractedDocument, 'documentType' | 'rawText'>
    & Partial<Pick<ExtractedDocument, 'totalAmount' | 'vendorName' | 'vendorAddress'>>,
): boolean {
  return doc.documentType === 'credit_note'
    || detectDocumentType(doc.rawText ?? '') === 'credit_note'
    || (doc.totalAmount ?? 0) < 0
    || hasCreditIndicator(doc.rawText ?? '', doc.totalAmount, [doc.vendorName, doc.vendorAddress]);
}

/**
 * May an AP route approve this document with nobody looking? The routes
 * cannot take the whole gate (a VLM-read image has no text to re-read), so
 * they take the credit refusal, the fallback policy and the ambiguity check.
 */
export function refusesUnattendedApproval(
  doc: Pick<ExtractedDocument, 'documentType' | 'rawText' | 'totalAmount' | 'warnings' | 'extractionMethod'>
    & Partial<Pick<ExtractedDocument, 'vendorName' | 'vendorAddress'>>,
): boolean {
  return isCreditNote(doc) || isFallbackExtraction(doc) || isAmbiguousTotal(doc);
}

/** The refusal a failed reconciliation is reported as. */
function unreconciledReason(off: Unreconciled): string {
  if (off.reason === 'paid') return `the document was paid ${off.value.toFixed(2)}, not the total read`;
  if (off.reason === 'larger') return `the document prints ${off.value.toFixed(2)}, more than the total read`;
  return `the document prints ${off.value.toFixed(2)} below its total, which nothing explains`;
}

/** Why this document may not post unattended, or null when nothing is left to choose. */
export function unattendedPostingRefusal(doc: UnattendedPostingInput): string | null {
  if (isCreditNote(doc)) return 'the document is a credit note, refund or return';
  if (isFallbackExtraction(doc)) return 'the figures were read by the text fallback, which never posts unattended';
  if (isUnreconciled(doc.warnings)) return 'the reader could not reconcile the amounts';

  if (namesForeignCurrency(doc.rawText ?? '')) return 'the document names a currency other than the rand';

  const total = doc.totalAmount;
  if (total === null || total === undefined || total <= 0) return 'no positive total was read';
  // A null VAT is not a zero: `buildExpenseJournalFromReceipt` then DERIVES 15%
  // of the total, which on a zero-rated slip is an input-tax claim the document
  // denies. A negative VAT on a positive total is a mis-read by definition.
  const vat = doc.vatAmount;
  if (vat === null || vat === undefined) return 'no VAT figure was read';
  if (vat < 0) return 'the VAT figure read is negative';
  if (doc.subtotal !== null && doc.subtotal !== undefined
    && Math.round((doc.subtotal + vat) * 100) / 100 !== total) {
    return 'the subtotal and VAT do not add up to the total';
  }

  const printed = [...new Set(extractTotalCandidates(doc.rawText ?? ''))];
  if (printed.length === 0) return 'no printed total could be read from the document text';
  if (printed.length > 1) return `the document prints ${printed.length} different totals`;
  if (printed[0] !== total) return 'the total read is not the total the document prints';
  // "One printed total" is measured over LABELS, and a payable under a label
  // the vocabulary lacks is not a candidate at all — six rounds of adding
  // labels never closed that. A figure larger than the total is measured over
  // AMOUNTS, and no spelling can hide it. See `ocrLargerFigure`.
  const larger = unexplainedLargerFigure(doc.rawText ?? '', total);
  if (larger !== null) return `the document prints ${larger.toFixed(2)}, more than the total read`;
  const adjusted = adjustmentAfterTotal(doc.rawText ?? '', total);
  if (adjusted !== null) return `the document adjusts the total by ${adjusted.toFixed(2)} after printing it`;
  // The WHITELIST: the whole document must reconcile against the total, not
  // the slice below it. A split tender printed ABOVE the total block, and a
  // charge printed BELOW the tender line, both evaded the slice.
  const off = unreconciledFigure(doc.rawText ?? '', total, doc);
  if (off) return unreconciledReason(off);

  // The TOTAL was re-read; the VAT was not, and a stored net and VAT are a
  // second number the entry is built from. Measured: a zero-rated slip whose
  // text prints only `Maize Meal 1 100.00 100.00 / Total 100.00`, stored by the
  // VLM as net 86.96 / VAT 13.04 / total 100.00, satisfied every check above —
  // the arithmetic adds up, the total agrees with the text — and posted EXP
  // 86.96 / VAT-in 13.04, R13.04 of input tax the document does not state. That
  // is the X2 defect ("no VAT figure was read") reached through the VLM instead
  // of the regex reader, so the answer is the same one: re-read, and refuse
  // what the text cannot corroborate.
  //
  // `extractAmounts` rather than `extractVatAmount` because the VAT selection
  // cross-checks against the PRINTED net and the bottom-most printed total, and
  // the stored `subtotal` may be a derived one. Feeding it the reader's own
  // inputs is what makes this re-read identical, by construction, to what a
  // regex-extracted document already holds.
  const reread = extractAmounts(doc.rawText ?? '');
  if (reread.vatAmount === null) return 'no VAT figure is printed on the document';
  if (reread.vatAmount !== vat) return 'the VAT figure read is not the VAT the document prints';
  return null;
}

/**
 * Is more than one figure in play for this document's payable total?
 *
 * The AP invoice routes do not consult `unattendedPostingRefusal` — they cannot,
 * because a PDF invoice read by the VLM carries no `rawText` to re-read and the
 * gate refuses that outright, which would send every one of them to a person.
 * But they auto-APPROVE, and on a document whose own totals are ambiguous that
 * approves a wrong number: measured, the mixed-basket slips A1/A2/A4 were
 * approved at R230.00 against a payable of R253.00, which is worse than the
 * behaviour they replaced. This is the part of the gate they can afford — a
 * document with no text to read yields no candidates and is not ambiguous, so
 * the VLM path is untouched.
 */
export function isAmbiguousTotal(
  doc: Pick<ExtractedDocument, 'rawText' | 'warnings'>,
): boolean {
  if (isUnreconciled(doc.warnings)) return true;
  const text = doc.rawText ?? '';
  // A document that names a currency other than the rand is not one this
  // ledger can approve at the figure printed on it. Measured on round 16:
  // `TOTAL USD 115.00 / ZAR 2116.00 / CARD 2116.00`, stored total 115.00, was
  // auto-approved at R115.00 against a payable of R2 116.00.
  if (namesForeignCurrency(text)) return true;
  const printed = [...new Set(extractTotalCandidates(text))];
  if (printed.length > 1) return true;
  // NO CANDIDATE is two different facts, and round 16 answered both the same
  // way. A document with no text at all cannot show it is ambiguous and is the
  // VLM-read image this check exists to let through. TEXT that yields no total
  // is the opposite: the vocabulary could not read the payable, so there is
  // nothing to compare the stored total against, and approving it approves a
  // figure the document never corroborated.
  if (printed.length === 0) return text.trim().length > 0;
  const off = unreconciledFigure(text, printed[0]!, extractAmounts(text));
  return unexplainedLargerFigure(text, printed[0]!) !== null
    || adjustmentAfterTotal(text, printed[0]!) !== null
    || off !== null;
}

/**
 * Does the document name a currency that is not the rand?
 *
 * `R`/`ZAR` are the rand. Anything else means the printed figures are not the
 * amounts this ledger would post, whatever the reader made of them. Round 17
 * read a symbol only BEFORE the figure and a code only, so an EU reverse-charge
 * invoice printing `Total 100,00 €` was auto-approved at R100. A bare `Pound`
 * is deliberately absent (a weight); `Pounds Sterling` is not.
 */
function namesForeignCurrency(text: string): boolean {
  return /(?<![A-Za-z])(?:USD|EUR|GBP|AUD|CAD|CHF|JPY|CNY|INR|NGN|KES|BWP|NAD|ZWL)(?![A-Za-z])/.test(text)
    // …before the figure or AFTER it, as EU invoices print it (`100,00 €`) …
    || /[$€£¥]\s*\d|\d\s*[$€£¥]/.test(text)
    // …or spelled out (`Total 115.00 (US Dollars)`, `Currency: Dollar`).
    || /(?<![A-Za-z])(?:(?:US|American|Australian|Canadian)\s+)?(?:Dollars?|Euros?|Pounds?\s+Sterling|Sterling|Yen|Yuan|Renminbi|Naira)(?![A-Za-z])/i.test(text);
}
