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
