/**
 * Fixture writers for the headline-figure integration suites: a posted (or
 * draft) two-line journal, a customer invoice and a supplier bill, written
 * straight to the tables as `user`. `add(n)` is the suite's "today + n days".
 */
import type { Pool } from 'pg';

export function fixtureWriters(pool: Pool, user: string, add: (n: number) => string) {
  async function journal(company: string, date: string, dr: string, cr: string, amount: number,
    opts: { status?: string; source?: string } = {}): Promise<void> {
    const entry = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,source,status,created_by)
       VALUES($1,$2,$3,'kpi fixture',$4,$5,$6)`,
      [entry, company, date, opts.source ?? 'manual', opts.status ?? 'posted', user]);
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,$4,0,'kpi',$5),($1,$3,0,$4,'kpi',$5)`, [entry, dr, cr, amount, company]);
  }

  async function invoice(company: string, customer: string, n: string, invoiceDate: string, due: string, total: number,
    status = 'approved', deleted = false): Promise<void> {
    await pool.query(
      `INSERT INTO customer_invoices
         (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by, deleted_at)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,0,$8,$9)`,
      [company, customer, n, invoiceDate, due, status, total, user, deleted ? new Date() : null]);
  }

  async function bill(company: string, supplier: string, n: string, due: string, total: number,
    opts: { status?: string; paid?: number; deleted?: boolean } = {}): Promise<void> {
    await pool.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [company, supplier, n, add(-40), due, opts.status ?? 'approved', total, opts.paid ?? 0, user, opts.deleted ? new Date() : null]);
  }

  return { journal, invoice, bill };
}
