/**
 * PO maintenance suites (update / cancel / close / set status, docs/design/mcp-po-maintenance.md): seeds beyond poBillLinkHarness
 * (a PO with quantities, goods receipts, catalogue items), the counters a "posts nothing" proof reads, and the cleanup that goes
 * with them. Tools run through `callTool` (poImportHarness): a real app_user request transaction. Disposable databases only.
 */
import type { Pool } from 'pg';
import type { BillFixture } from './budgetBillFixture';

export { callTool, type Json } from './poImportHarness';

let seq = 0;

export interface QtyPo { po: string; number: string; items: string[] }

/** A PO with one line per `{qty, price, received}` (no VAT, opex / FT), default approved, dated 2026-06-02. */
export async function seedQtyPo(
  pool: Pool, f: BillFixture,
  opts: { status?: string; lines: Array<{ qty: number; price: number; received?: number }>; external?: boolean; number?: string; acct?: string },
): Promise<QtyPo> {
  const po = crypto.randomUUID();
  const number = opts.number ?? `PM${String(100 + seq++)}-${po.slice(0, 4)}`;
  const subtotal = opts.lines.reduce((s, l) => s + Math.round(l.qty * l.price * 100), 0) / 100;
  await pool.query(
    `INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status, subtotal, tax_amount, total, external_system, external_ref)
     VALUES ($1, $2, $3, $4, '2026-06-02', $5, $6, 0, $6, $7, $8)`,
    [po, f.co, number, f.supplier, opts.status ?? 'approved', subtotal, opts.external ? 'sage' : null, opts.external ? `ref-${po}` : null]);
  const items: string[] = [];
  for (const [i, l] of opts.lines.entries()) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, quantity_received, gl_account_id, sort_order, cc1_id)
       VALUES ($1, $2, $3, $4, $5, 0, $6, 0, $7, $8, $9, $10)`,
      [id, po, `Qty line ${i}`, l.qty, l.price, Math.round(l.qty * l.price * 100) / 100, l.received ?? 0, opts.acct ?? f.acc.opex, i, f.cc.FT]);
    items.push(id);
  }
  return { po, number, items };
}

/** A goods receipt against the PO (one grn_items row per PO line, the line's received quantity). */
export async function seedGrn(pool: Pool, f: BillFixture, po: QtyPo): Promise<string> {
  const grn = crypto.randomUUID();
  await pool.query(
    `INSERT INTO goods_received_notes (id, company_id, grn_number, purchase_order_id, received_by, status) VALUES ($1, $2, $3, $4, 'tester', 'received')`,
    [grn, f.co, `GRN-${grn.slice(0, 8)}`, po.po]);
  await pool.query(
    `INSERT INTO grn_items (grn_id, po_item_id, quantity_received)
     SELECT $1, id, quantity_received FROM po_items WHERE purchase_order_id = $2`, [grn, po.po]);
  return grn;
}

/** A catalogue item with a purchases account and VAT type. */
export async function seedItem(pool: Pool, f: BillFixture, o: { code: string; acct: string | null; vat?: string; active?: boolean }): Promise<string> {
  return String((await pool.query(
    `INSERT INTO items (company_id, code, description, purchases_account_id, vat_on_purchases, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [f.co, o.code, `Item ${o.code}`, o.acct, o.vat ?? 'standard', o.active ?? true])).rows[0].id);
}

export async function poRow(pool: Pool, po: string) {
  return (await pool.query(
    `SELECT status, closed_from_status, supplier_id, to_char(order_date, 'YYYY-MM-DD') AS order_date, reference, notes, subtotal::TEXT AS subtotal,
            tax_amount::TEXT AS tax_amount, total::TEXT AS total, approved_by, to_char(expected_delivery_date, 'YYYY-MM-DD') AS delivery
       FROM purchase_orders WHERE id = $1`, [po])).rows[0] as Record<string, string | null>;
}

export async function poLines(pool: Pool, po: string) {
  return (await pool.query(
    `SELECT description, quantity::TEXT AS quantity, unit_price::TEXT AS unit_price, tax_rate::TEXT AS tax_rate, line_total::TEXT AS line_total,
            tax_amount::TEXT AS tax_amount, gl_account_id, cc1_id, cc2_id, bu_id, item_id
       FROM po_items WHERE purchase_order_id = $1 ORDER BY sort_order`, [po])).rows as Array<Record<string, string | null>>;
}

/** The ledger rows of the company: what none of these tools may touch. */
export async function glCount(pool: Pool, f: BillFixture): Promise<{ entries: number; lines: number }> {
  return (await pool.query(
    `SELECT (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS entries,
            (SELECT count(*)::INT FROM gl_journal_lines l WHERE l.journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)) AS lines`,
    [f.co])).rows[0] as { entries: number; lines: number };
}

/** The audit rows of a PO, oldest first. */
export async function auditOf(pool: Pool, f: BillFixture, po: string) {
  return (await pool.query(
    `SELECT action, user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'purchase_order' AND entity_id = $2 ORDER BY created_at, id`,
    [f.co, po])).rows as Array<{ action: string; user_id: string; changes: { fields: Array<{ field: string; old: string | null; new: string | null }>; metadata?: Record<string, string> } }>;
}

export async function budgetEvents(pool: Pool, po: string): Promise<Array<{ outcome: string }>> {
  return (await pool.query('SELECT outcome FROM budget_check_events WHERE document_id = $1 ORDER BY decided_at', [po])).rows;
}

/** Receipts and items hang off the company's POs and are not in dropBillFixture's list: drop them first. */
export async function dropMaintExtras(pool: Pool, f: BillFixture | undefined): Promise<void> {
  if (!f) return;
  await pool.query('DELETE FROM grn_items WHERE grn_id IN (SELECT id FROM goods_received_notes WHERE company_id = $1)', [f.co]);
  await pool.query('DELETE FROM goods_received_notes WHERE company_id = $1', [f.co]);
  await pool.query('UPDATE po_items SET item_id = NULL WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [f.co]);
  await pool.query('DELETE FROM items WHERE company_id = $1', [f.co]);
}
