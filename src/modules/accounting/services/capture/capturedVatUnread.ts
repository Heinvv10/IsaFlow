/**
 * Which supplier invoices were raised from a captured document whose VAT the
 * extraction never read (K-072 r30)?
 *
 * The capture routes used to invent 15/115 of the total as such a draft's
 * `tax_amount`, and the MCP approve tools could then post it as input VAT with
 * nobody looking — on a non-VAT vendor's bill, VAT the vendor never charged.
 * The routes no longer invent it, but a draft created before that change still
 * carries the invented figure, and an agent has no way to know the VAT was
 * never on the document. So an agent may not approve such a bill: it is read
 * off the captured document itself (`extracted_data.vatAmount` null or absent,
 * which is exactly what the builder saw), not off anything the draft says.
 * A person approving in the attended workflow is not affected.
 *
 * Round 31: the same holds for a DRAFT JOURNAL raised from a captured receipt
 * (`receipt-to-journal`, the petty-cash branch of `capture/[id]/post-expense`)
 * — the receipt builder invented the same 15/115 VAT Input leg, and the MCP
 * `post_journal` tool posted any draft by id.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export const CAPTURED_VAT_UNREAD_REASON = 'it was raised from a captured document whose VAT was never read, '
  + 'so its VAT is not evidenced by the document — a person must approve it';

export async function invoicesWithUnreadCapturedVat(companyId: string, invoiceIds: readonly string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const rows = (await sql`
    SELECT si.id
    FROM supplier_invoices si
    JOIN captured_documents cd ON cd.id = si.source_document_id AND cd.company_id = si.company_id
    WHERE si.company_id = ${companyId}::UUID
      AND si.id = ANY(${[...invoiceIds]}::UUID[])
      AND COALESCE(jsonb_typeof(cd.extracted_data -> 'vatAmount'), 'null') = 'null'
  `) as DbRow[];
  return new Set(rows.map((row) => String(row.id)));
}

export const JOURNAL_VAT_UNREAD_REASON = 'it was raised from a captured document whose VAT was never read, '
  + 'so any VAT on it is not evidenced by the document — a person must post it';

/** Is this journal raised from a captured document whose VAT was never read? */
export async function journalHasUnreadCapturedVat(companyId: string, journalId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM gl_journal_entries je
    JOIN captured_documents cd ON cd.id = je.source_document_id AND cd.company_id = je.company_id
    WHERE je.company_id = ${companyId}::UUID AND je.id = ${journalId}::UUID
      AND COALESCE(jsonb_typeof(cd.extracted_data -> 'vatAmount'), 'null') = 'null'
  `) as DbRow[];
  return rows.length > 0;
}
