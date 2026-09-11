/**
 * Does a draft raised from a captured document carry the VAT that document
 * shows (K-072 r30–r32)?
 *
 * The capture builders used to INVENT 15/115 of the total as a draft's VAT —
 * when the extraction read no VAT at all, and also when it read the VAT but not
 * the net (a till slip printing `VAT 0.00`, or `VAT 13.04`, got 117.42 or
 * 18.26). The builders no longer invent it, but a draft created before that
 * change still carries the invented figure, and the MCP tools that post a draft
 * by id (`approve_supplier_invoice`, `bulk_approve_supplier_invoices`,
 * `post_journal`) have no way to know it was never on the document.
 *
 * So an agent may post such a draft only when its VAT equals, to the cent, the
 * VAT read off the captured document itself (`extracted_data.vatAmount`; null,
 * absent or not a number counts as NONE, i.e. 0). A draft of an unread document
 * that claims no VAT therefore posts; any VAT the document does not show is
 * refused. A person approving in the attended workflow is not affected.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export const CAPTURED_VAT_UNEVIDENCED_REASON = 'its VAT is not the VAT read off the captured document it was raised from '
  + '(none, where none was read), so the document does not evidence it — a person must approve it';

/** Of these supplier invoices, which carry a `tax_amount` their captured document does not show? */
export async function invoicesWithUnevidencedVat(companyId: string, invoiceIds: readonly string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const rows = (await sql`
    SELECT si.id
    FROM supplier_invoices si
    JOIN captured_documents cd ON cd.id = si.source_document_id AND cd.company_id = si.company_id
    WHERE si.company_id = ${companyId}::UUID
      AND si.id = ANY(${[...invoiceIds]}::UUID[])
      AND ABS(COALESCE(si.tax_amount, 0) - CASE WHEN jsonb_typeof(cd.extracted_data -> 'vatAmount') = 'number'
            THEN (cd.extracted_data ->> 'vatAmount')::NUMERIC ELSE 0 END) > 0.01
  `) as DbRow[];
  return new Set(rows.map((row) => String(row.id)));
}

export const JOURNAL_VAT_UNEVIDENCED_REASON = 'its VAT Input is not the VAT read off the captured document it was raised from '
  + '(none, where none was read), so the document does not evidence it — a person must post it';

/**
 * Does this journal, raised from a captured document, carry a VAT Input the
 * document does not show? Its VAT Input is the net debit on lines to a
 * `vat_input` account — the account the receipt builders resolve for that leg.
 */
export async function journalHasUnevidencedVat(companyId: string, journalId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM gl_journal_entries je
    JOIN captured_documents cd ON cd.id = je.source_document_id AND cd.company_id = je.company_id
    WHERE je.company_id = ${companyId}::UUID AND je.id = ${journalId}::UUID
      AND ABS((
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
        FROM gl_journal_lines jl
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = je.company_id
        WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
          AND ga.account_subtype = 'vat_input'
      ) - CASE WHEN jsonb_typeof(cd.extracted_data -> 'vatAmount') = 'number'
            THEN (cd.extracted_data ->> 'vatAmount')::NUMERIC ELSE 0 END) > 0.01
  `) as DbRow[];
  return rows.length > 0;
}
