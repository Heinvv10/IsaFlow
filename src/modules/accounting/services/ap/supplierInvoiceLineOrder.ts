/**
 * The order a supplier invoice's lines are read in. One definition for both TypeScript readers
 * (supplierInvoiceService.getSupplierInvoice, supplierInvoiceDraftUpdateGuards.planLines): the invoice screen's
 * line numbers, the posting order (buildExpenseLines puts the rounding residual on the LAST line) and a refusal's
 * "stored line N" must agree. Lines inserted together tie on created_at, so the content (then id) breaks the tie
 * instead of heap order.
 *
 * Migration 708's approval_document_digest hashes the lines in exactly this order and cannot import it:
 * tests/unit/services/ap/supplierInvoiceLineOrderMatches708.test.ts pins the two together. The table must be
 * aliased `sii` in the query this is spliced into (`sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)`).
 */
import { sql } from '@/lib/neon';

export const SUPPLIER_INVOICE_LINE_ORDER_BY =
  'ORDER BY sii.created_at, sii.description, sii.gl_account_id, sii.quantity, '
  + 'sii.unit_price, sii.tax_rate, sii.tax_amount, sii.line_total, '
  + 'sii.project_id, sii.cost_center_id, sii.vat_classification, sii.id';

/** A line about to be written, by the columns SUPPLIER_INVOICE_LINE_ORDER_BY sorts on (created_at ties: one write). */
export interface LineOrderKey {
  id?: string | null;
  description: string;
  glAccountId?: string | null;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
  projectId?: string | null;
  costCenterId?: string | null;
  vatClassification?: string | null;
}

/**
 * The indices of `lines` in the order they will be READ BACK for posting once written together (budgets P5-2b,
 * breaker R6-1): Postgres sorts them itself with the column types and the database collation the stored rows get, so
 * the order is the real one, never a JS imitation (text collation, NULLS LAST, numeric scale). A line with no `id`
 * yet ties only with an identical line, whose order is then the database's.
 */
export async function storedLineOrder(lines: readonly LineOrderKey[]): Promise<number[]> {
  if (lines.length <= 1) return lines.map((_, i) => i);
  const col = <T>(f: (l: LineOrderKey) => T) => lines.map(f);
  const rows = (await sql`
    SELECT (sii.i - 1)::INT AS i
      FROM (SELECT u.*, now() AS created_at
              FROM unnest(${col((l) => l.id ?? null)}::UUID[], ${col((l) => l.description)}::TEXT[],
                          ${col((l) => l.glAccountId ?? null)}::UUID[], ${col((l) => l.quantity)}::NUMERIC(12,4)[],
                          ${col((l) => l.unitPrice)}::NUMERIC(15,2)[], ${col((l) => l.taxRate)}::NUMERIC(5,2)[],
                          ${col((l) => l.taxAmount)}::NUMERIC(15,2)[], ${col((l) => l.lineTotal)}::NUMERIC(15,2)[],
                          ${col((l) => l.projectId ?? null)}::UUID[], ${col((l) => l.costCenterId ?? null)}::UUID[],
                          ${col((l) => l.vatClassification ?? null)}::TEXT[])
                   WITH ORDINALITY AS u(id, description, gl_account_id, quantity, unit_price, tax_rate, tax_amount, line_total,
                                        project_id, cost_center_id, vat_classification, i)) sii
    ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as Array<{ i: number }>;
  return rows.map((r) => Number(r.i));
}
