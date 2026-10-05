/**
 * R-195 fixture: companies, paid customer invoices and Paystack / Stitch payment requests written
 * straight into the tables. Taken from the R-186 archive fixture when archiving was retired
 * (2026-10-05); it touches no archive_* table, so it keeps working after migration 855 drops them.
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const INVOICE_DAY = '2001-01-01';
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
export const user = randomUUID();

export async function addUser(): Promise<void> {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@r195.test`]);
}

/** A company; `member` adds `user` to it, which app_user RLS needs. */
export async function addCompany(id: string, member = false): Promise<void> {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `R195 ${id.slice(0, 8)}`]);
  if (member) {
    await pool.query("INSERT INTO company_users(company_id,user_id,role,is_default) VALUES($1,$2,'admin',false)", [id, user]);
  }
}

export async function addInvoice(companyId: string, status: 'paid' | 'cancelled' | 'approved',
  invoiceDate = INVOICE_DAY): Promise<string> {
  const id = randomUUID();
  const customer = randomUUID();
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, companyId, `R195 ${id.slice(0, 8)}`]);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,created_by,
       invoice_date,total_amount,amount_paid,status)
     VALUES($1,$2,$3,$4,$5,$6,100,$7,$8)`,
    [id, companyId, `R195-${id.slice(0, 8)}`, customer, user, invoiceDate, status === 'paid' ? 100 : 0, status],
  );
  return id;
}

export async function addPaystackRequest(companyId: string, invoiceId: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO paystack_payment_requests(company_id,purpose,customer_invoice_id,paystack_reference,amount_cents,status)
     VALUES($1,'customer_invoice',$2,$3,10000,'completed') RETURNING id`,
    [companyId, invoiceId, `r195-${randomUUID()}`],
  )).rows[0]!.id as string;
}

export async function addStitchRequest(companyId: string, invoiceId: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO stitch_payment_requests(company_id,purpose,customer_invoice_id,external_reference,amount_cents)
     VALUES($1,'customer_invoice',$2,$3,10000) RETURNING id`,
    [companyId, invoiceId, `r195-${randomUUID()}`],
  )).rows[0]!.id as string;
}

export async function cleanup(companies: string[]): Promise<void> {
  try {
    for (const id of companies) {
      for (const t of ['paystack_payment_requests', 'stitch_payment_requests', 'audit_log', 'customer_invoices',
        'customers', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id=$1`, [id]);
      }
      await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
}
