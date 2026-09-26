/**
 * Pre-filing check: what SUPPORTS each input-VAT claim in the period?
 *
 * The control recon (vatExceptionsService) ties the filed VAT201 to the VAT
 * control accounts, so it no longer catches a claim that is in the ledger and
 * in the return with nothing behind it — a hand journal debiting VAT Input,
 * say. This check does. Every posted journal with vat_input movement in the
 * period is classified by its LINK to a document — never by `source`, which
 * does not say (receipt-to-journal posts as 'auto_invoice') — and checked
 * against that document at the same cent tolerance as the rest of the report:
 *
 *   bill               supplier_invoices.gl_journal_entry_id (or, for a DRC
 *                      journal, source_record_id). Not re-checked here:
 *                      exception 5 already reconciles bill VAT to its journal.
 *   expense claim      expense_claims.posted_je_id → SUM(line vat_amount).
 *   captured document  je.source_document_id → captured_documents
 *                      extracted_data.vatAmount (none read → none claimable).
 *   credit note        credit_notes.gl_journal_entry_id → |tax_amount|.
 *   VAT adjustment     vat_adjustments.gl_journal_entry_id — an approved,
 *                      reasoned adjustment, but no tax invoice.
 *   bank               bank_transactions.matched_journal_line_id on a line of
 *                      the journal; VAT at most rate/(1+rate) of the money.
 *
 * REVERSAL CHAINS NET ON THEIR ROOT (review round 1, B1; vatInputSupportQuery).
 * A reversal, a reversal of the reversal and so on are walked up to the root;
 * the chain's movement in the period is ONE figure, and the root's links —
 * a late-claim companion's original's — decide its support. A chain whose
 * period net is nil claims nothing (a claim reversed in its own period); a net
 * CLAIM needs support, however it came about (reinstated by reversing the
 * reversal); a net REDUCTION needs none unless it is a credit note, whose tax
 * it must match. A reversal dated in a LATER period does not rescue the
 * original: its claim stands in its own period.
 *
 * ONE DOCUMENT, ONE CLAIM (B2). A captured document's VAT is compared with the
 * net claims of EVERY chain naming it, over every period to the period end:
 * two journals claiming the same R30 slip claim R60 and both block as
 * `document_over_claimed`. The document's VAT is `extracted_data.vatAmount`,
 * read as the capture pipeline reads a printed amount (`parseAmount`); a value
 * it cannot read is `unreadable_document_vat` and blocks — never a silent 0.
 * No VAT read at all is none claimable.
 *
 * BLOCKING (`unsupportedInputVat`): a positive claim with no link at all, or
 * a linked claim that disagrees with its document. NOT blocking (Hein,
 * 2026-09-25): a claim supported only by the bank line or a VAT adjustment is
 * listed as "no tax invoice on file" — real money moved, but s16(2) wants the
 * tax invoice before the deduction, so somebody should attach it.
 */
import { AMOUNT, parseAmount } from '@/modules/accounting/services/core/ocrAmountParsing';
import { SA_VAT_RATE } from './vatBoxBasis';
import type { InputVatSupportLine, InputVatSupportKind } from './vatExceptionsTypes';
import { queryInputVatSupport } from './vatInputSupportQuery';

const CENT = 0.005;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dateStr(v: unknown): string {
  if (v instanceof Date) {
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${v.getFullYear()}-${m}-${d}`;
  }
  return String(v ?? '').slice(0, 10);
}

/** One reversal chain's facts, as the query returns them (keyed on its root). */
export interface InputVatSupportFacts {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  source: string | null;
  description: string;
  /** Net vat_input movement of the chain IN THE PERIOD. Positive is a claim. */
  claimedVat: number;
  /** Net vat_input movement of the chain up to the period end. */
  claimedToDate: number;
  expenseClaimVat: number | null;
  /** A linked captured document's VAT: a number, or 'unreadable'. Null when no document. */
  capturedDocumentVat: number | 'unreadable' | null;
  /** Net claims of every chain naming the same captured document, to the period end. */
  documentClaimedVat: number | null;
  creditNoteVat: number | null;
  vatAdjustment: boolean;
  /** Σ |amount| of the bank lines behind the journal (matched or provisional). */
  bankAmount: number | null;
  /** Item 2: an invoice attached to the SAME bank line — presence only, no VAT to compare. */
  hasBankAttachment: boolean;
}

export type SupportVerdict =
  | { blocking: true; line: InputVatSupportLine }
  | { blocking: false; line: InputVatSupportLine | null };

function line(
  f: InputVatSupportFacts, kind: InputVatSupportKind, documentVat: number | null,
  reason: InputVatSupportLine['reason'], documentClaimedVat: number | null = null,
): InputVatSupportLine {
  return {
    journalEntryId: f.journalEntryId, entryNumber: f.entryNumber, entryDate: f.entryDate,
    source: f.source, description: f.description, claimedVat: r2(f.claimedVat),
    supportKind: kind, documentVat: documentVat === null ? null : r2(documentVat), reason,
    documentClaimedVat: documentClaimedVat === null ? null : r2(documentClaimedVat),
  };
}

const PRINTED_AMOUNT = new RegExp(`^\\s*${AMOUNT}\\s*$`);

/**
 * `extracted_data.vatAmount` as a figure. The extractor writes a number; a
 * string is read the way the capture pipeline reads a printed amount
 * (`parseAmount`: "15,00", "1 234,50", "15.00"). Anything else is UNREADABLE —
 * not 0, which would read a document nobody could read as "no VAT". Absent or
 * null is no VAT read, which supports no claim.
 */
export function readDocumentVat(raw: unknown): number | 'unreadable' {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 'unreadable';
  if (typeof raw === 'string' && PRINTED_AMOUNT.test(raw)) return parseAmount(raw);
  return 'unreadable';
}

/**
 * Pure: the verdict on one chain that is NOT a bill's (the query leaves those
 * out). Document links outrank the bank: a receipt that was also matched to
 * its bank line is supported by the receipt.
 */
export function classifyInputVatSupport(f: InputVatSupportFacts, rate: number): SupportVerdict {
  const none: SupportVerdict = { blocking: false, line: null };
  // A net REDUCTION needs no support — it gives SARS back tax — unless it is a
  // credit note, whose reduction must be the credit note's tax.
  if (f.claimedVat <= CENT) {
    if (f.claimedVat < -CENT && f.creditNoteVat !== null
      && Math.abs(Math.abs(f.claimedVat) - Math.abs(f.creditNoteVat)) > CENT) {
      return { blocking: true, line: line(f, 'credit_note', f.creditNoteVat, 'amount_mismatch') };
    }
    return none;
  }
  if (f.expenseClaimVat !== null) {
    return Math.abs(f.claimedToDate - f.expenseClaimVat) > CENT
      ? { blocking: true, line: line(f, 'expense_claim', f.expenseClaimVat, 'amount_mismatch') }
      : none;
  }
  if (f.capturedDocumentVat === 'unreadable') {
    return { blocking: true, line: line(f, 'captured_document', null, 'unreadable_document_vat') };
  }
  if (f.capturedDocumentVat !== null) {
    const onDocument = f.documentClaimedVat ?? f.claimedToDate;
    if (Math.abs(onDocument - f.capturedDocumentVat) <= CENT) return none;
    const shared = Math.abs(onDocument - f.claimedToDate) > CENT;
    return { blocking: true, line: line(f, 'captured_document', f.capturedDocumentVat,
      shared ? 'document_over_claimed' : 'amount_mismatch', onDocument) };
  }
  // A credit note's chain netting to a claim is the credit note being undone.
  if (f.creditNoteVat !== null) return none;
  if (f.vatAdjustment) return { blocking: false, line: line(f, 'vat_adjustment', null, 'no_tax_invoice') };
  if (f.bankAmount !== null) {
    const ceiling = r2(f.bankAmount * rate / (1 + rate));
    if (f.claimedVat > ceiling + CENT) {
      return { blocking: true, line: line(f, 'bank', ceiling, 'amount_mismatch') };
    }
    // Item 2: an invoice attached to the bank line is a tax invoice on file —
    // the journal is fully supported, not merely "no tax invoice on file".
    if (f.hasBankAttachment) return none;
    return { blocking: false, line: line(f, 'bank', null, 'no_tax_invoice') };
  }
  return { blocking: true, line: line(f, 'none', null, 'no_document') };
}

export interface InputVatSupportResult {
  unsupported: InputVatSupportLine[];
  withoutTaxInvoice: InputVatSupportLine[];
}

/** Every reversal chain with input-VAT movement in the period that is not a bill's. */
export async function findInputVatSupport(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<InputVatSupportResult> {
  const rows = await queryInputVatSupport(companyId, periodStart, periodEnd, CENT);
  const result: InputVatSupportResult = { unsupported: [], withoutTaxInvoice: [] };
  for (const r of rows) {
    const verdict = classifyInputVatSupport({
      journalEntryId: String(r.id),
      entryNumber: String(r.entry_number ?? ''),
      entryDate: dateStr(r.entry_date),
      source: r.source == null ? null : String(r.source),
      description: String(r.description ?? ''),
      claimedVat: num(r.claimed_vat) ?? 0,
      claimedToDate: num(r.claimed_to_date) ?? 0,
      expenseClaimVat: r.is_expense_claim === true ? (num(r.expense_claim_vat) ?? 0) : null,
      capturedDocumentVat: r.has_document === true ? readDocumentVat(r.document_vat_raw) : null,
      documentClaimedVat: num(r.document_claimed_vat),
      creditNoteVat: num(r.credit_note_vat),
      vatAdjustment: r.is_vat_adjustment === true,
      bankAmount: num(r.bank_amount),
      hasBankAttachment: r.has_bank_attachment === true,
    }, SA_VAT_RATE);
    if (verdict.blocking) result.unsupported.push(verdict.line);
    else if (verdict.line) result.withoutTaxInvoice.push(verdict.line);
  }
  return result;
}
