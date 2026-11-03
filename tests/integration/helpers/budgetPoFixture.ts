/**
 * Budgets P5-3 (purchase-order approval with the budget check), real PostgreSQL. Builds on the P5-2 bill
 * fixture (`budgetBillFixture.ts`: one company, owner + manager, opex BB-6100 at CC1 FT 1 000 / HT 0 a month,
 * travel BB-6200 company 500 a month, nob BB-6300 unbudgeted, FY2027 = Mar 2026 - Feb 2027). POs are seeded
 * as the superuser, dated `${month}-02`; requests run as app_user through withAuth (`callRoute`).
 */
import type { Pool } from 'pg';
import approveRoute from '../../../pages/api/accounting/purchase-orders/[id]/approve';
import poRoute from '../../../pages/api/accounting/purchase-orders/[id]';
import { callRoute, type BillFixture } from './budgetBillFixture';

export interface PoLine { acct?: string | null; amount: number; cc1?: string | null; cc2?: string | null; bu?: string | null }

/** A PO (default draft) with one line per entry, qty 1 at `amount`; returns its id and line ids in order. */
export async function makePo(
  pool: Pool, f: BillFixture, month: string, lines: PoLine[], opts: { status?: string; id?: string } = {},
): Promise<{ po: string; items: string[] }> {
  const po = opts.id ?? crypto.randomUUID();
  const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  await pool.query(
    `INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status, subtotal, tax_amount, total)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7)`,
    [po, f.co, `PO3-${po.slice(0, 8)}`, f.supplier, `${month}-02`, opts.status ?? 'draft', subtotal]);
  const items: string[] = [];
  for (const [i, l] of lines.entries()) {
    const item = crypto.randomUUID();
    await pool.query(
      `INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, gl_account_id,
         cc1_id, cc2_id, bu_id, sort_order) VALUES ($1, $2, 'P5-3 line', 1, $3, 0, $3, 0, $4, $5, $6, $7, $8)`,
      [item, po, l.amount, l.acct ?? null, l.cc1 ?? null, l.cc2 ?? null, l.bu ?? null, i]);
    items.push(item);
  }
  return { po, items };
}

export async function poState(pool: Pool, po: string) {
  return (await pool.query(
    'SELECT status, approved_by, approved_at, updated_by FROM purchase_orders WHERE id = $1', [po])).rows[0] as
    { status: string; approved_by: string | null; approved_at: Date | null; updated_by: string | null };
}

export async function poItems(pool: Pool, po: string) {
  return (await pool.query(
    `SELECT gl_account_id, cc1_id, cc2_id, bu_id, line_total::TEXT AS line_total FROM po_items WHERE purchase_order_id = $1
      ORDER BY sort_order`, [po])).rows as Array<{ gl_account_id: string | null; cc1_id: string | null; cc2_id: string | null; bu_id: string | null; line_total: string }>;
}

export const approvePo = (f: BillFixture, user: string, po: string, body: Record<string, unknown> = {}) =>
  callRoute(approveRoute as never, f, user, `/api/accounting/purchase-orders/${po}/approve`, body, { id: po });

export const putPo = (f: BillFixture, user: string, po: string, body: Record<string, unknown>) =>
  callRoute(poRoute as never, f, user, `/api/accounting/purchase-orders/${po}`, body, { method: 'PUT', id: po });
