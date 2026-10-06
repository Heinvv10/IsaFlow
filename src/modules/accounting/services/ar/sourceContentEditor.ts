/**
 * Who EDITED the price of a quote or a sales order (R-035 PR4 round 2; Hein,
 * 2026-10-06: whoever sets the price upstream is an author).
 *
 * A customer invoice converted from a quote or an order counts their creator
 * and every editor whose change moved what they bill among its authors —
 * derived by approval_document_authors (migration 865), refused as approvers.
 * The creator is created_by; editors are `content_authors`, stamped here by
 * the edit itself and ONLY when it changed what the document bills: the
 * customer, the date the invoice will carry, the totals and every line's
 * description, quantity, price, VAT rate, amount and account. A notes-only
 * edit stamps nobody. Nothing is written at creation, so creating and
 * converting a quote (golden path a) touches no column migration 865 adds.
 *
 * The row is locked before the before-fingerprint is read, and the edit and
 * its stamp share a savepoint — supplierInvoiceContentEditor's reasons: a
 * concurrent edit must not make a reverting edit look like no change, and an
 * edit must never stand with its author unrecorded.
 */
import { sql, withSavepoint } from '@/lib/neon';

export type PricedSource = { kind: 'quote'; id: string } | { kind: 'sales_order'; id: string };

type Row = Record<string, unknown>;

/** What the source bills, hashed; null when the row is not this company's. */
async function fingerprint(companyId: string, source: PricedSource): Promise<string | null> {
  const rows = source.kind === 'quote'
    ? (await sql`
        SELECT md5(jsonb_build_array(q.client_id, q.quote_date, trim_scale(q.subtotal), trim_scale(q.tax_amount),
          trim_scale(q.total), COALESCE((
            SELECT jsonb_agg(jsonb_build_array(l.description, trim_scale(l.quantity), trim_scale(l.unit_price),
                     trim_scale(l.tax_rate), trim_scale(l.amount), l.gl_account_id) ORDER BY l.sort_order, l.description)
            FROM customer_quote_lines l WHERE l.quote_id = q.id), '[]'::jsonb))::TEXT) AS f
        FROM customer_quotes q WHERE q.id = ${source.id}::UUID AND q.company_id = ${companyId}::UUID
      `) as Row[]
    : (await sql`
        SELECT md5(jsonb_build_array(so.customer_id, so.order_date, trim_scale(so.subtotal), trim_scale(so.tax_amount),
          trim_scale(so.total_amount), COALESCE((
            SELECT jsonb_agg(jsonb_build_array(i.description, trim_scale(i.quantity), trim_scale(i.unit_price),
                     trim_scale(i.tax_rate), trim_scale(i.line_total), i.gl_account_id) ORDER BY i.line_number, i.description)
            FROM customer_sales_order_items i WHERE i.sales_order_id = so.id), '[]'::jsonb))::TEXT) AS f
        FROM customer_sales_orders so WHERE so.id = ${source.id}::UUID AND so.company_id = ${companyId}::UUID
      `) as Row[];
  return rows[0]?.f != null ? String(rows[0].f) : null;
}

/** Run `edit` on the source, then stamp `editedBy` as an author if it changed what the source bills. */
export async function withSourceEditorStamp<T>(
  companyId: string, source: PricedSource, editedBy: string, edit: () => Promise<T>,
): Promise<T> {
  return withSavepoint('source_editor_stamp', async () => {
    if (source.kind === 'quote') {
      await sql`SELECT 1 FROM customer_quotes WHERE id = ${source.id}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`;
    } else {
      await sql`SELECT 1 FROM customer_sales_orders WHERE id = ${source.id}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`;
    }
    const before = await fingerprint(companyId, source);
    const result = await edit();
    if (before !== null && (await fingerprint(companyId, source)) !== before) {
      if (source.kind === 'quote') {
        await sql`
          UPDATE customer_quotes SET content_authors = approval_add_author(content_authors, ${editedBy}::UUID)
          WHERE id = ${source.id}::UUID AND company_id = ${companyId}::UUID
        `;
      } else {
        await sql`
          UPDATE customer_sales_orders SET content_authors = approval_add_author(content_authors, ${editedBy}::UUID)
          WHERE id = ${source.id}::UUID AND company_id = ${companyId}::UUID
        `;
      }
    }
    return result;
  });
}
