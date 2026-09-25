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
 * A late-claim companion is classified by the journal it claims for
 * (late_claim_of_id). A reversal is never a claim, and a journal whose posted
 * reversal is dated on or before the period end is left out with it — the
 * pair nets, exactly as vatInputOverclaim groups it. A reversal dated in a
 * LATER period does not rescue the original: its claim stands in its own
 * period, and blocks there unless a document supports it.
 *
 * BLOCKING (`unsupportedInputVat`): a positive claim with no link at all, or
 * a linked claim that disagrees with its document. NOT blocking (Hein,
 * 2026-09-25): a claim supported only by the bank line or a VAT adjustment is
 * listed as "no tax invoice on file" — real money moved, but s16(2) wants the
 * tax invoice before the deduction, so somebody should attach it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { SA_VAT_RATE } from './vatBoxBasis';
import type { InputVatSupportLine, InputVatSupportKind } from './vatExceptionsTypes';

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

/** One journal's facts, as the query returns them. */
export interface InputVatSupportFacts {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  source: string | null;
  description: string;
  /** Net vat_input movement (debit − credit). Positive is a claim. */
  claimedVat: number;
  expenseClaimVat: number | null;
  capturedDocumentVat: number | null;
  creditNoteVat: number | null;
  vatAdjustment: boolean;
  /** Σ |amount| of bank transactions matched to a line of the journal. */
  bankAmount: number | null;
}

export type SupportVerdict =
  | { blocking: true; line: InputVatSupportLine }
  | { blocking: false; line: InputVatSupportLine | null };

function line(
  f: InputVatSupportFacts, kind: InputVatSupportKind, documentVat: number | null,
  reason: InputVatSupportLine['reason'],
): InputVatSupportLine {
  return {
    journalEntryId: f.journalEntryId, entryNumber: f.entryNumber, entryDate: f.entryDate,
    source: f.source, description: f.description, claimedVat: r2(f.claimedVat),
    supportKind: kind, documentVat: documentVat === null ? null : r2(documentVat), reason,
  };
}

/**
 * Pure: the verdict on one journal that is NOT a bill's or a reversal (the
 * query leaves those out). Document links outrank the bank: a receipt that was
 * also matched to its bank line is supported by the receipt.
 */
export function classifyInputVatSupport(f: InputVatSupportFacts, rate: number): SupportVerdict {
  const differs = (doc: number) => Math.abs(f.claimedVat - doc) > CENT;
  if (f.expenseClaimVat !== null) {
    return differs(f.expenseClaimVat)
      ? { blocking: true, line: line(f, 'expense_claim', f.expenseClaimVat, 'amount_mismatch') }
      : { blocking: false, line: null };
  }
  if (f.capturedDocumentVat !== null) {
    return differs(f.capturedDocumentVat)
      ? { blocking: true, line: line(f, 'captured_document', f.capturedDocumentVat, 'amount_mismatch') }
      : { blocking: false, line: null };
  }
  if (f.creditNoteVat !== null) {
    // A supplier credit note REDUCES input VAT: the journal moves −tax.
    return Math.abs(Math.abs(f.claimedVat) - Math.abs(f.creditNoteVat)) > CENT
      ? { blocking: true, line: line(f, 'credit_note', f.creditNoteVat, 'amount_mismatch') }
      : { blocking: false, line: null };
  }
  // Below here only a CLAIM needs support: a reduction with nothing behind it
  // gives SARS back tax; it is not a deduction anybody has to evidence.
  if (f.claimedVat <= CENT) return { blocking: false, line: null };
  if (f.vatAdjustment) return { blocking: false, line: line(f, 'vat_adjustment', null, 'no_tax_invoice') };
  if (f.bankAmount !== null) {
    const ceiling = r2(f.bankAmount * rate / (1 + rate));
    return f.claimedVat > ceiling + CENT
      ? { blocking: true, line: line(f, 'bank', ceiling, 'amount_mismatch') }
      : { blocking: false, line: line(f, 'bank', null, 'no_tax_invoice') };
  }
  return { blocking: true, line: line(f, 'none', null, 'no_document') };
}

export interface InputVatSupportResult {
  unsupported: InputVatSupportLine[];
  withoutTaxInvoice: InputVatSupportLine[];
}

/** The journals with vat_input movement in the period that are not a bill's or a reversal. */
export async function findInputVatSupport(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<InputVatSupportResult> {
  const rows = (await sql`
    WITH vj AS (
      SELECT je.id, je.entry_number, je.entry_date, je.source,
        COALESCE(je.description, '') AS description,
        COALESCE(je.late_claim_of_id, je.id) AS doc_je_id,
        SUM(jl.debit - jl.credit) AS claimed_vat
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND je.entry_date >= ${periodStart}::DATE
        AND je.entry_date <= ${periodEnd}::DATE
        AND je.source IS DISTINCT FROM 'auto_vat_submission'
        AND je.reversal_of_id IS NULL
        -- A reversed pair nets, as the per-journal over-claim nets it: a claim
        -- whose POSTED reversal is dated by the period end claims nothing in
        -- this return. Reversed only in a later period, it still stands here.
        AND NOT EXISTS (
          SELECT 1 FROM gl_journal_entries rv
          WHERE rv.company_id = ${companyId}::UUID AND rv.reversal_of_id = je.id
            AND rv.status = 'posted' AND rv.entry_date <= ${periodEnd}::DATE
        )
        AND ga.account_subtype = 'vat_input'
      GROUP BY je.id
      HAVING ABS(SUM(jl.debit - jl.credit)) > ${CENT}
    )
    SELECT vj.*,
      (SELECT SUM(ecl.vat_amount) FROM expense_claims ec
        JOIN expense_claim_lines ecl ON ecl.claim_id = ec.id AND ecl.company_id = ${companyId}::UUID
        WHERE ec.company_id = ${companyId}::UUID AND ec.posted_je_id = vj.doc_je_id) AS expense_claim_vat,
      EXISTS (SELECT 1 FROM expense_claims ec
        WHERE ec.company_id = ${companyId}::UUID AND ec.posted_je_id = vj.doc_je_id) AS is_expense_claim,
      CASE WHEN cd.id IS NULL THEN NULL
        WHEN jsonb_typeof(cd.extracted_data -> 'vatAmount') = 'number'
          OR (jsonb_typeof(cd.extracted_data -> 'vatAmount') = 'string'
              AND cd.extracted_data ->> 'vatAmount' ~ '^-?[0-9]+([.][0-9]+)?$')
          THEN (cd.extracted_data ->> 'vatAmount')::NUMERIC
        ELSE 0 END AS captured_document_vat,
      (SELECT SUM(cn.tax_amount) FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID AND cn.gl_journal_entry_id = vj.doc_je_id) AS credit_note_vat,
      EXISTS (SELECT 1 FROM vat_adjustments va
        WHERE va.company_id = ${companyId}::UUID AND va.gl_journal_entry_id = vj.doc_je_id) AS is_vat_adjustment,
      (SELECT SUM(ABS(bt.amount)) FROM bank_transactions bt
        JOIN gl_journal_lines ml ON ml.id = bt.matched_journal_line_id AND ml.company_id = ${companyId}::UUID
        WHERE bt.company_id = ${companyId}::UUID AND ml.journal_entry_id = vj.doc_je_id) AS bank_amount
    FROM vj
    JOIN gl_journal_entries orig ON orig.id = vj.doc_je_id AND orig.company_id = ${companyId}::UUID
    LEFT JOIN captured_documents cd ON cd.id = orig.source_document_id AND cd.company_id = ${companyId}::UUID
    WHERE NOT EXISTS (
      SELECT 1 FROM supplier_invoices si
      WHERE si.company_id = ${companyId}::UUID
        AND (si.gl_journal_entry_id = vj.doc_je_id
          OR (orig.source = 'auto_vat_adjustment' AND si.id = orig.source_record_id))
    )
    ORDER BY vj.entry_date, vj.entry_number
  `) as DbRow[];

  const result: InputVatSupportResult = { unsupported: [], withoutTaxInvoice: [] };
  for (const r of rows) {
    const verdict = classifyInputVatSupport({
      journalEntryId: String(r.id),
      entryNumber: String(r.entry_number ?? ''),
      entryDate: dateStr(r.entry_date),
      source: r.source == null ? null : String(r.source),
      description: String(r.description ?? ''),
      claimedVat: num(r.claimed_vat) ?? 0,
      expenseClaimVat: r.is_expense_claim === true ? (num(r.expense_claim_vat) ?? 0) : null,
      capturedDocumentVat: num(r.captured_document_vat),
      creditNoteVat: num(r.credit_note_vat),
      vatAdjustment: r.is_vat_adjustment === true,
      bankAmount: num(r.bank_amount),
    }, SA_VAT_RATE);
    if (verdict.blocking) result.unsupported.push(verdict.line);
    else if (verdict.line) result.withoutTaxInvoice.push(verdict.line);
  }
  return result;
}
