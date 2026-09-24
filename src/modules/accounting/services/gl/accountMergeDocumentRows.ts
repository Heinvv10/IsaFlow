/**
 * The DOCUMENT lines a GL account merge carries with it: bill lines,
 * expense-claim lines, purchase-order lines and capture events coded to the
 * source account.
 *
 * These used to fall into the configuration sweep and refuse the merge, which
 * made any account ever coded on a bill unmergeable — and nothing else can
 * recode a posted bill's lines, so that was a dead end. They are the document
 * side of the journal lines the merge already moves, so they move with them,
 * in the same transaction and under the same account locks, and the record
 * names every row that moved (`gl_account_merges.moved_document_rows`).
 *
 * Every statement is tenant-scoped. Two of the tables carry no `company_id`
 * and are scoped through their parent document's. The FK on `gl_account_id`
 * checks only that the account exists, not whose it is, so an unscoped UPDATE
 * would move another company's row that (corruptly) names the source.
 *
 * `countDocumentRows` (the dry run) and `repointDocumentRows` (the write) use
 * the SAME predicates, and `mergeAccounts` aborts if their numbers differ.
 */
import { sql } from '@/lib/neon';

export const DOCUMENT_ROW_TABLES = [
  'supplier_invoice_items', 'expense_claim_lines', 'po_items', 'capture_events',
] as const;

export type DocumentRowTable = typeof DOCUMENT_ROW_TABLES[number];
export type DocumentRowCounts = Record<DocumentRowTable, number>;
/** Row ids per table, each list sorted. The shape stored on the merge record. */
export type MovedDocumentRows = Record<DocumentRowTable, string[]>;

export async function countDocumentRows(
  companyId: string, sourceId: string,
): Promise<DocumentRowCounts> {
  const rows = (await sql`
    SELECT
      (SELECT COUNT(*)::INT FROM supplier_invoice_items i
         JOIN supplier_invoices si ON si.id = i.supplier_invoice_id
        WHERE si.company_id = ${companyId}::UUID AND i.gl_account_id = ${sourceId}::UUID)
        AS supplier_invoice_items,
      (SELECT COUNT(*)::INT FROM expense_claim_lines
        WHERE company_id = ${companyId}::UUID AND gl_account_id = ${sourceId}::UUID)
        AS expense_claim_lines,
      (SELECT COUNT(*)::INT FROM po_items p
         JOIN purchase_orders po ON po.id = p.purchase_order_id
        WHERE po.company_id = ${companyId}::UUID AND p.gl_account_id = ${sourceId}::UUID)
        AS po_items,
      (SELECT COUNT(*)::INT FROM capture_events
        WHERE company_id = ${companyId}::UUID AND resolved_gl_account_id = ${sourceId}::UUID)
        AS capture_events
  `) as Record<string, unknown>[];
  const r = rows[0] ?? {};
  return {
    supplier_invoice_items: Number(r.supplier_invoice_items ?? 0),
    expense_claim_lines: Number(r.expense_claim_lines ?? 0),
    po_items: Number(r.po_items ?? 0),
    capture_events: Number(r.capture_events ?? 0),
  };
}

function ids(rows: unknown): string[] {
  return (rows as { id: string }[]).map((r) => String(r.id)).sort();
}

/** Repoint the source's document rows onto the target. Only this company's rows move. */
export async function repointDocumentRows(
  companyId: string, sourceId: string, targetId: string,
): Promise<MovedDocumentRows> {
  const supplierInvoiceItems = ids(await sql`
    UPDATE supplier_invoice_items i
       SET gl_account_id = ${targetId}::UUID, updated_at = NOW()
      FROM supplier_invoices si
     WHERE si.id = i.supplier_invoice_id
       AND si.company_id = ${companyId}::UUID
       AND i.gl_account_id = ${sourceId}::UUID
    RETURNING i.id
  `);
  const expenseClaimLines = ids(await sql`
    UPDATE expense_claim_lines
       SET gl_account_id = ${targetId}::UUID
     WHERE company_id = ${companyId}::UUID
       AND gl_account_id = ${sourceId}::UUID
    RETURNING id
  `);
  const poItems = ids(await sql`
    UPDATE po_items p
       SET gl_account_id = ${targetId}::UUID
      FROM purchase_orders po
     WHERE po.id = p.purchase_order_id
       AND po.company_id = ${companyId}::UUID
       AND p.gl_account_id = ${sourceId}::UUID
    RETURNING p.id
  `);
  const captureEvents = ids(await sql`
    UPDATE capture_events
       SET resolved_gl_account_id = ${targetId}::UUID, updated_at = NOW()
     WHERE company_id = ${companyId}::UUID
       AND resolved_gl_account_id = ${sourceId}::UUID
    RETURNING id
  `);
  return {
    supplier_invoice_items: supplierInvoiceItems,
    expense_claim_lines: expenseClaimLines,
    po_items: poItems,
    capture_events: captureEvents,
  };
}

/** Per-table counts of a moved set, for comparing the write against the dry run. */
export function countsOf(moved: MovedDocumentRows): DocumentRowCounts {
  return {
    supplier_invoice_items: moved.supplier_invoice_items.length,
    expense_claim_lines: moved.expense_claim_lines.length,
    po_items: moved.po_items.length,
    capture_events: moved.capture_events.length,
  };
}
