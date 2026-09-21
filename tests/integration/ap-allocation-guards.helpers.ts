// tests/integration/ap-allocation-guards.helpers.ts
//
// K-063 / K-064 / K-066 fixture, layered on the R-068 one: company A owns
// SUP_A and SUP_A2, company B owns SUP_B. These helpers add bills and payments
// in the statuses the guards are about, and count what a refused request left.

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { ids } from './supplier-ownership-fence.helpers';

export const today = new Date().toISOString().slice(0, 10);

export async function bill(pool: Pool, opts: {
  company?: string; supplier: string; status: string; total?: number; paid?: number;
}): Promise<string> {
  const id = randomUUID();
  const total = opts.total ?? 1000;
  await pool.query(
    `INSERT INTO supplier_invoices (id, company_id, supplier_id, invoice_number, invoice_date, due_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $4, CURRENT_DATE - 5, CURRENT_DATE + 25, $5, 0, $5, $6, $7, $8)`,
    [id, opts.company ?? ids.A, opts.supplier, `K06X-${id.slice(0, 8)}`, total, opts.paid ?? 0,
      opts.status, ids.USER],
  );
  return id;
}

/** A processed, unallocated payment — what supplier-allocations POST applies. */
export async function processedPayment(pool: Pool, supplier: string, total = 1000): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO supplier_payments (id, company_id, supplier_id, payment_number, payment_date,
       total_amount, payment_method, status, created_by)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, 'eft', 'processed', $6)`,
    [id, ids.A, supplier, `K06X-PAY-${id.slice(0, 8)}`, total, ids.USER],
  );
  return id;
}

export async function billState(pool: Pool, id: string): Promise<{ paid: number; status: string }> {
  const { rows } = await pool.query('SELECT amount_paid, status FROM supplier_invoices WHERE id = $1', [id]);
  return { paid: Number(rows[0].amount_paid), status: String(rows[0].status) };
}

/** Allocation rows naming any of these bills, from any payment of company A. */
export async function allocationsOn(pool: Pool, billIds: string[]): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM payment_allocations pa JOIN supplier_payments sp ON sp.id = pa.payment_id
     WHERE sp.company_id = $1 AND pa.invoice_id = ANY($2::uuid[])`, [ids.A, billIds]);
  return Number(rows[0].n);
}

export async function rowCount(pool: Pool, table: 'supplier_payments' | 'supplier_payment_batches'): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM ${table} WHERE company_id = $1`, [ids.A]);
  return Number(rows[0].n);
}
