/**
 * link_bills_to_purchase_order suites: seeds for POs and bills (as the superuser, net storage, ex-VAT line amounts) and
 * the counters the "posts nothing" proof reads. The tools themselves run through `callTool` (poImportHarness): a real
 * app_user request transaction, committed after the handler returns.
 */
import type { Pool } from 'pg';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { makeBill, openRequest, type BillFixture } from './budgetBillFixture';

export type { Json } from './poImportHarness';

let seq = 0;

export interface SeededPo { po: string; number: string; items: string[] }

/** A PO (default approved) with one line per amount (qty 1, no VAT): subtotal = total = the sum. */
export async function seedPo(
  pool: Pool, f: BillFixture,
  opts: { status?: string; lines: number[]; acct?: string | null; supplier?: string; date?: string; number?: string; cc1?: string },
): Promise<SeededPo> {
  const po = crypto.randomUUID();
  const number = opts.number ?? `PL${String(1000 + seq++)}-${po.slice(0, 4)}`;
  const subtotal = Math.round(opts.lines.reduce((s, a) => s + a, 0) * 100) / 100;
  await pool.query(
    `INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status, subtotal, tax_amount, total)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7)`,
    [po, f.co, number, opts.supplier ?? f.supplier, `${opts.date ?? '2026-06'}-02`, opts.status ?? 'approved', subtotal]);
  const items: string[] = [];
  for (const [i, amount] of opts.lines.entries()) {
    const item = crypto.randomUUID();
    await pool.query(
      `INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, gl_account_id, sort_order, cc1_id)
       VALUES ($1, $2, $3, 1, $4, 0, $4, 0, $5, $6, $7)`,
      [item, po, `PO line ${i}`, amount, opts.acct === undefined ? f.acc.opex : opts.acct, i, opts.cc1 ?? null]);
    items.push(item);
  }
  return { po, number, items };
}

export interface SeededBill { id: string; lines: string[]; subtotal: number }

/** A bill (default approved) with one expense line per amount on opex / FT; returns the line ids in insertion order. */
export async function seedBill(
  pool: Pool, f: BillFixture, opts: { status?: string; lines: number[]; supplier?: string; date?: string },
): Promise<SeededBill> {
  const id = await makeBill(pool, f, opts.lines.map((amount) => ({ acct: f.acc.opex, amount, cc1: f.cc.FT })),
    { status: opts.status ?? 'approved', date: opts.date });
  if (opts.supplier) await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [id, opts.supplier]);
  const lines = (await pool.query('SELECT id FROM supplier_invoice_items WHERE supplier_invoice_id = $1 ORDER BY unit_price, id', [id]))
    .rows.map((r) => String(r.id));
  return { id, lines, subtotal: Math.round(opts.lines.reduce((s, a) => s + a, 0) * 100) / 100 };
}

/** The ledger rows of the company, and the money columns of the given bills: what a link must leave alone. */
export async function ledgerSnapshot(pool: Pool, f: BillFixture, bills: readonly string[]) {
  const c = (await pool.query(
    `SELECT (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS entries,
            (SELECT count(*)::INT FROM gl_journal_lines l WHERE l.journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)) AS lines`,
    [f.co])).rows[0] as { entries: number; lines: number };
  const b = (await pool.query(
    `SELECT id, status, subtotal::TEXT AS subtotal, tax_amount::TEXT AS tax_amount, total_amount::TEXT AS total_amount,
            amount_paid::TEXT AS amount_paid, gl_journal_entry_id FROM supplier_invoices WHERE id = ANY($1::UUID[]) ORDER BY id`, [[...bills]])).rows;
  return { ...c, bills: b };
}

export async function linkRows(pool: Pool, f: BillFixture, where = 'true') {
  return (await pool.query(
    `SELECT l.id, l.purchase_order_id AS po, l.supplier_invoice_id AS bill, l.amount::TEXT AS amount, l.source, l.external_system, l.external_ref,
            l.closed_po_from_status, l.created_by FROM purchase_order_bill_links l WHERE l.company_id = $1 AND ${where} ORDER BY l.created_at, l.id`,
    [f.co])).rows as Array<{ id: string; po: string; bill: string; amount: string; source: string; external_system: string | null;
      external_ref: string | null; closed_po_from_status: string | null; created_by: string | null }>;
}

export async function poStatus(pool: Pool, po: string): Promise<string> {
  return String((await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [po])).rows[0].status);
}
export async function billHeader(pool: Pool, bill: string): Promise<string | null> {
  const v = (await pool.query('SELECT purchase_order_id FROM supplier_invoices WHERE id = $1', [bill])).rows[0].purchase_order_id;
  return v == null ? null : String(v);
}
export async function lineLinks(pool: Pool, bill: string): Promise<Array<string | null>> {
  return (await pool.query('SELECT po_item_id FROM supplier_invoice_items WHERE supplier_invoice_id = $1 ORDER BY unit_price, id', [bill]))
    .rows.map((r) => (r.po_item_id == null ? null : String(r.po_item_id)));
}

/** Approves a draft bill through the real service (its journal is posted); committed. */
export async function approveBill(pool: Pool, f: BillFixture, bill: string): Promise<void> {
  const req = await openRequest(pool, f, f.owner);
  try { await req.run(() => approveSupplierInvoice(f.co, bill, f.owner)); await req.commit(); } catch (e) { await req.rollback(); throw e; }
}

/** Another supplier of the same company. */
export async function seedSupplier(pool: Pool, f: BillFixture, name = 'Second supplier'): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, $3, true)', [id, f.co, name]);
  return id;
}

/**
 * A bill with exactly the stored figures given (the amount rule's fixtures: a gross-stored bill, a rounding residual, a R0
 * line): `items[i].total` is the line's stored line_total, `poItem` the PO line it names. Line ids come back in item order.
 */
export async function seedRawBill(
  pool: Pool, f: BillFixture,
  o: { items: Array<{ total: number; poItem?: string | null }>; subtotal: number; total: number; taxRate?: number; status?: string; header?: string | null; supplier?: string },
): Promise<SeededBill> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount, total_amount,
       created_by, status, purchase_order_id) VALUES ($1, $2, $3, $4, '2026-06-15', $5, $6, $7, $8, $9, $10, $11)`,
    [id, f.co, `RAW-${id.slice(0, 8)}`, o.supplier ?? f.supplier, o.subtotal, o.taxRate ?? 15, Math.round((o.total - o.subtotal) * 100) / 100, o.total,
      f.owner, o.status ?? 'approved', o.header ?? null]);
  const lines: string[] = [];
  for (const [i, it] of o.items.entries()) {
    const lid = crypto.randomUUID();
    await pool.query(
      `INSERT INTO supplier_invoice_items (id, supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id, cc1_id, po_item_id)
       VALUES ($1, $2, $3, 1, $4, 15, 0, $4, $5, $6, $7)`,
      [lid, id, `L${String(i).padStart(2, '0')}`, it.total, f.acc.opex, f.cc.FT, it.poItem ?? null]);
    lines.push(lid);
  }
  return { id, lines, subtotal: o.subtotal };
}
