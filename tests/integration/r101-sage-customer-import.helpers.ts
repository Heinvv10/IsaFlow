/**
 * Shared set-up for the Sage customer-invoice importer integration tests
 * (R-101). The request-transaction driver is the supplier side's
 * (r021-sage-supplier-import.helpers.ts); only the staging table differs.
 */
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export function sageCustomerStaging(pool: Pool) {
  async function seedStaging(
    companyId: string,
    opts: { sageId: string | null; invoiceNumber: string; customerName: string; total: number; invoiceDate?: string },
  ): Promise<string> {
    const rows = await pool.query<{ id: string }>(
      `INSERT INTO sage_customer_invoices
         (company_id, sage_id, invoice_number, customer_name, invoice_date, total_amount, migration_status)
       VALUES ($1,$2,$3,$4,$6,$5,'pending') RETURNING id`,
      [companyId, opts.sageId, opts.invoiceNumber, opts.customerName, opts.total, opts.invoiceDate ?? '2026-06-30'],
    );
    return rows.rows[0]!.id;
  }

  async function staged(stagingId: string): Promise<{ migration_status: string; gl_customer_invoice_id: string | null }> {
    return (await pool.query(
      'SELECT migration_status, gl_customer_invoice_id FROM sage_customer_invoices WHERE id=$1', [stagingId],
    )).rows[0]!;
  }

  async function addCustomer(companyId: string, name: string, paymentTerms: number | null = 30): Promise<string> {
    return (await pool.query<{ id: string }>(
      'INSERT INTO customers(company_id,name,payment_terms) VALUES($1,$2,$3) RETURNING id',
      [companyId, name, paymentTerms],
    )).rows[0]!.id;
  }

  /** An invoice captured in IsaFlow by hand, before the migration ran. */
  async function addInvoice(
    companyId: string, customerId: string, user: string,
    opts: { number: string; total: number; status?: string; externalRef?: string; deleted?: boolean; createdAgo?: string },
  ): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO customer_invoices (company_id, invoice_number, customer_id, invoice_date, subtotal, total_amount,
         status, external_ref, external_system, deleted_at, created_by, created_at)
       VALUES ($1,$2,$3,'2026-05-01',$4,$4,$5,$6,$7,CASE WHEN $8 THEN NOW() END,$9,NOW() - $10::INTERVAL) RETURNING id`,
      [companyId, opts.number, customerId, opts.total, opts.status ?? 'approved',
        opts.externalRef ?? null, opts.externalRef ? 'sage' : null, opts.deleted ?? false, user, opts.createdAgo ?? '0'],
    )).rows[0]!.id;
  }

  async function setUp(companies: Array<[string, string]>, user: string): Promise<void> {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    for (const [id, name] of companies) {
      await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
      await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [id, user]);
    }
  }

  async function tearDown(companyIds: string[], user: string): Promise<void> {
    try {
      for (const id of companyIds) {
        await pool.query('DELETE FROM sage_customer_invoices WHERE company_id=$1', [id]);
        await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [id]);
        await pool.query('DELETE FROM customers WHERE company_id=$1', [id]);
        await pool.query('DELETE FROM gl_migration_runs WHERE company_id=$1', [id]);
        await pool.query('DELETE FROM company_users WHERE company_id=$1', [id]);
        await pool.query('DELETE FROM companies WHERE id=$1', [id]);
      }
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally { await pool.end(); }
  }

  const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

  return { seedStaging, staged, addCustomer, addInvoice, setUp, tearDown, tag };
}
