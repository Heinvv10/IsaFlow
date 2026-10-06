/**
 * The UPSTREAM authors of a customer invoice minted from a recurring template
 * (R-035 PR4 review F1).
 *
 * A template is content a person wrote; whoever runs the schedule only mints
 * it. Recording the minter alone (created_by) let the template's pricer
 * approve the invoice another user's run minted from their price. A minted
 * invoice carries no link back to its template, so the template's authors are
 * WRITTEN into the invoice's `content_authors` (migration 865) — which
 * approval_document_authors reads, and the decide path refuses — right after
 * the invoice and its lines are written, before any request is raised or the
 * invoice approved. Read from the template's own author columns:
 *   - recurring_invoices: created_by and content_authors (every editor whose
 *     change moved what it bills, and a merging user);
 *   - recurring_transaction_templates: the same (created_by is VARCHAR, cast
 *     only when it is a canonical uuid).
 * Append-only and de-duplicated; a NULL or non-uuid author adds nobody.
 *
 * Conversions (quote, sales order, time entries) are NOT stamped here: their
 * invoices keep a link to the source, so approval_document_authors DERIVES
 * those authors at read time (migration 865) and the converting services
 * write nothing. Supplier invoices are deliberately not covered (865).
 */
import { sql } from '@/lib/neon';

export type UpstreamSource =
  | { kind: 'recurring_invoice'; id: string }
  | { kind: 'recurring_transaction_template'; id: string };

type Row = Record<string, unknown>;

/** The source's authors, company-scoped. One statement per source: a table name cannot be a parameter. */
async function authorsOf(companyId: string, source: UpstreamSource): Promise<string[]> {
  let rows: Row[];
  switch (source.kind) {
    case 'recurring_invoice':
      rows = (await sql`
        SELECT a::TEXT AS author FROM recurring_invoices ri,
          unnest(ri.content_authors || ARRAY[ri.created_by]) a
        WHERE ri.id = ${source.id}::UUID AND ri.company_id = ${companyId}::UUID
      `) as Row[];
      break;
    case 'recurring_transaction_template':
      rows = (await sql`
        SELECT a::TEXT AS author FROM recurring_transaction_templates t,
          unnest(t.content_authors || ARRAY[CASE WHEN t.created_by
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t.created_by::UUID END]) a
        WHERE t.id = ${source.id}::UUID AND t.company_id = ${companyId}::UUID
      `) as Row[];
      break;
  }
  return rows.map((r) => r.author).filter((a): a is string => typeof a === 'string');
}

/** Union the source's authors into the minted invoice's content_authors. */
export async function stampUpstreamAuthors(companyId: string, invoiceId: string, source: UpstreamSource): Promise<void> {
  const authors = [...new Set(await authorsOf(companyId, source))];
  if (authors.length === 0) return;
  await sql`
    UPDATE customer_invoices
    SET content_authors = content_authors || ARRAY(
      SELECT DISTINCT a FROM unnest(${authors}::UUID[]) a WHERE a <> ALL(content_authors) ORDER BY a)
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
}
