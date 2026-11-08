/**
 * One tax invoice, one VAT claim, when a captured document is attached to a bank line (Hein, 2026-11-07).
 *
 * A document is proof of a transaction. Attaching it to a bank line is refused only when that would make it back a
 * SECOND input-VAT claim: the line's own journal claims input VAT AND the document already backs a different claim —
 * a posted, standing journal (its source_document_id, or an active gl_journal_document_links row), a live bill with
 * VAT (supplier_invoices.source_document_id, or the capture's matched_invoice_id), or a live expense claim line with
 * VAT. Everything else is allowed: proof of payment (the line claims no VAT, or is not allocated yet), and the line's
 * OWN journal (a receipt matched to its payment, a provisional journal).
 *
 * Input VAT is `vat_input` OR `vat_input_late_claim`: a section 16(3) late claim parks the original journal's VAT on
 * the clearing account (its companion carries the `vat_input` line), and it is still that journal's claim.
 *
 * Bills and expense claims count while live, before their VAT posts (a bill pending approval, an approved claim):
 * they are about to claim it. A document sits on ONE bank line; attaching it moves it (captureBankTxAttachService),
 * so its previous line is never a second claim.
 *
 * Known limits: the check runs at attach time. A line allocated WITH VAT after the attach, or a DRAFT journal naming
 * the document that is posted later, is not re-checked here; scripts/audit/vat-document-double-use.sql finds those.
 * Callers hold the bank line and document locks (bank line, then document), so a peer cannot slip in between.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { journalStandsFragment } from '../shared/journalInForceAsAt';

export interface OtherVatClaim {
  kind: 'journal' | 'bill' | 'expense_claim';
  id: string;
  reference: string;
}

const CENT = 0.005;

/** The other VAT claim `documentId` backs that attaching it to `bankTxId` would duplicate, or null. */
export async function findOtherVatClaim(companyId: string, documentId: string, bankTxId: string): Promise<OtherVatClaim | null> {
  // The line's journals: provisional, or the journal of its matched line.
  const lineJournals = ((await sql`
    SELECT bt.provisional_je_id AS je_id FROM bank_transactions bt
     WHERE bt.id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID AND bt.provisional_je_id IS NOT NULL
    UNION
    SELECT ml.journal_entry_id FROM bank_transactions bt
      JOIN gl_journal_lines ml ON ml.id = bt.matched_journal_line_id AND ml.company_id = ${companyId}::UUID
     WHERE bt.id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID
  `) as DbRow[]).map((r) => String(r.je_id));
  if (lineJournals.length === 0) return null;

  const [lineClaims] = (await sql`
    SELECT 1 FROM gl_journal_entries je
     WHERE je.company_id = ${companyId}::UUID AND je.id = ANY(${lineJournals}::UUID[])
       AND je.status = 'posted' AND ${journalStandsFragment('je.id', companyId)}
       AND (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM gl_journal_lines jl
              JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
             WHERE jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
               AND ga.account_subtype IN ('vat_input', 'vat_input_late_claim')) > ${CENT}
     LIMIT 1
  `) as DbRow[];
  if (!lineClaims) return null;

  const [journal] = (await sql`
    SELECT je.id, je.entry_number FROM gl_journal_entries je
     WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND ${journalStandsFragment('je.id', companyId)}
       AND je.id <> ALL(${lineJournals}::UUID[])
       AND (je.source_document_id = ${documentId}::UUID
         OR EXISTS (SELECT 1 FROM gl_journal_document_links l WHERE l.company_id = ${companyId}::UUID
                     AND l.journal_entry_id = je.id AND l.captured_document_id = ${documentId}::UUID AND l.unlinked_at IS NULL))
       AND (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM gl_journal_lines jl
              JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
             WHERE jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
               AND ga.account_subtype IN ('vat_input', 'vat_input_late_claim')) > ${CENT}
     LIMIT 1
  `) as DbRow[];
  if (journal) return { kind: 'journal', id: String(journal.id), reference: String(journal.entry_number ?? '') };

  const [bill] = (await sql`
    SELECT si.id, si.invoice_number FROM supplier_invoices si
     WHERE si.company_id = ${companyId}::UUID AND si.status NOT IN ('draft', 'cancelled')
       AND ABS(COALESCE(si.tax_amount, 0)) > ${CENT}
       AND (si.gl_journal_entry_id IS NULL OR si.gl_journal_entry_id <> ALL(${lineJournals}::UUID[]))
       AND (si.source_document_id = ${documentId}::UUID
         OR si.id = (SELECT cd.matched_invoice_id FROM captured_documents cd
                      WHERE cd.id = ${documentId}::UUID AND cd.company_id = ${companyId}::UUID))
     LIMIT 1
  `) as DbRow[];
  if (bill) return { kind: 'bill', id: String(bill.id), reference: String(bill.invoice_number ?? '') };

  const [claim] = (await sql`
    SELECT ec.id, ec.claim_number FROM expense_claim_lines ecl
      JOIN expense_claims ec ON ec.id = ecl.claim_id AND ec.company_id = ${companyId}::UUID
     WHERE ecl.company_id = ${companyId}::UUID AND ecl.source_document_id = ${documentId}::UUID
       AND ABS(ecl.vat_amount) > ${CENT} AND ec.status NOT IN ('draft', 'rejected', 'cancelled')
       AND (ec.posted_je_id IS NULL OR ec.posted_je_id <> ALL(${lineJournals}::UUID[]))
     LIMIT 1
  `) as DbRow[];
  if (claim) return { kind: 'expense_claim', id: String(claim.id), reference: String(claim.claim_number ?? '') };
  return null;
}

/** The refusal shown to the user. */
export function otherVatClaimMessage(c: OtherVatClaim): string {
  const what = c.kind === 'journal' ? `journal ${c.reference}` : c.kind === 'bill' ? `bill ${c.reference}` : `expense claim ${c.reference}`;
  return `This document already supports the VAT on ${what}. This bank line also claims VAT, so one tax invoice would `
    + `back two VAT claims. Match the bank line to ${what} instead, or allocate the line without VAT.`;
}
