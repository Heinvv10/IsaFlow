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

export type UnattendedPostingInput = Pick<
  ExtractedDocument,
  'documentType' | 'rawText' | 'subtotal' | 'vatAmount' | 'totalAmount' | 'warnings'
>;

/**
 * A credit note, by its own classification OR by its text.
 *
 * Every posting path this gate serves books a PURCHASE, so a refund read with
 * positive figures — the usual credit-note layout, and `Total 115.00-` or
 * `-R115.00`, which the amount grammar reads positive — posted EXP / VAT-in /
 * bank credit, the direction of the entry reversed. `detectDocumentType`
 * answered `credit_note` on every one of them and nothing consulted it. The
 * text is read as well as the stored field because the VLM classifies on its
 * own and a stored extraction predates any later change to either.
 */
export function isCreditNote(doc: Pick<ExtractedDocument, 'documentType' | 'rawText'>): boolean {
  return doc.documentType === 'credit_note' || detectDocumentType(doc.rawText ?? '') === 'credit_note';
}

/** Why this document may not post unattended, or null when nothing is left to choose. */
export function unattendedPostingRefusal(doc: UnattendedPostingInput): string | null {
  if (isCreditNote(doc)) return 'the document is a credit note';
  if (isUnreconciled(doc.warnings)) return 'the reader could not reconcile the amounts';

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
  return new Set(extractTotalCandidates(doc.rawText ?? '')).size > 1;
}
