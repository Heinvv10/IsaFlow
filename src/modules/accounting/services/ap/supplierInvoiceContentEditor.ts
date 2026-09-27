/**
 * Records who changed the CONTENT an approval covers (R-035 PR2-must 1).
 *
 * `supplier_invoices.content_authors` (migration 712, append-only) gains every
 * person whose edit moved the approval digest — the one SQL definition of the
 * content, `approval_document_digest`; `content_edited_at` the last time. The
 * decide path refuses all of them, and the creator, as approvers
 * (gl/approvalAuthors.ts). Stamped only when the digest actually
 * moved, so an edit to what an approval does not cover (notes, due date,
 * payment terms) makes nobody an author. Every edit path of a bill wraps its
 * write in this: the detail PUT and MCP update_supplier_invoice here; the
 * account and supplier merges stamp their own sets of bills.
 *
 * The edit and its stamp share a savepoint: a caller that answers a throw with
 * a 4xx (withAuth COMMITs those) must not keep an edit whose author went
 * unrecorded — that author could then approve their own content.
 */
import { sql, withSavepoint } from '@/lib/neon';

export async function withContentEditorStamp<T>(
  companyId: string, invoiceId: string, editedBy: string, edit: () => Promise<T>,
): Promise<T> {
  return withSavepoint('content_editor_stamp', async () => {
    const [before] = (await sql`
      SELECT approval_document_digest(${companyId}::UUID, 'supplier_invoice', ${invoiceId}::UUID) AS digest
    `) as { digest: string | null }[];
    const result = await edit();
    await sql`
      UPDATE supplier_invoices
      SET content_authors = approval_add_author(content_authors, ${editedBy}::UUID), content_edited_at = NOW()
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        AND approval_document_digest(company_id, 'supplier_invoice', id) IS DISTINCT FROM ${before?.digest ?? null}::TEXT
    `;
    return result;
  });
}
