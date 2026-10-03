/**
 * R-186 fixture: companies with paid/cancelled pre-cutoff customer invoices, payment requests
 * written straight into the tables, and a driver that runs a service inside one request
 * transaction (optionally as app_user with the withAuth GUCs, so RLS applies).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';

export const CUTOFF = '2005-01-01';
export const OLD_DAY = '2001-01-01';
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
export const user = randomUUID();

export async function addUser(): Promise<void> {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@r186.test`]);
}

/** A company; `member` adds `user` to it, which app_user RLS needs. */
export async function addCompany(id: string, member = false): Promise<void> {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `R186 ${id.slice(0, 8)}`]);
  if (member) {
    await pool.query("INSERT INTO company_users(company_id,user_id,role,is_default) VALUES($1,$2,'admin',false)", [id, user]);
  }
}

export async function addInvoice(companyId: string, status: 'paid' | 'cancelled'): Promise<string> {
  const id = randomUUID();
  const customer = randomUUID();
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, companyId, `R186 ${id.slice(0, 8)}`]);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,created_by,
       invoice_date,total_amount,amount_paid,status)
     VALUES($1,$2,$3,$4,$5,$6,100,$7,$8)`,
    [id, companyId, `R186-${id.slice(0, 8)}`, customer, user, OLD_DAY, status === 'paid' ? 100 : 0, status],
  );
  return id;
}

export async function addPaystackRequest(companyId: string, invoiceId: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO paystack_payment_requests(company_id,purpose,customer_invoice_id,paystack_reference,amount_cents,status)
     VALUES($1,'customer_invoice',$2,$3,10000,'completed') RETURNING id`,
    [companyId, invoiceId, `r186-${randomUUID()}`],
  )).rows[0]!.id as string;
}

export async function addStitchRequest(companyId: string, invoiceId: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO stitch_payment_requests(company_id,purpose,customer_invoice_id,external_reference,amount_cents)
     VALUES($1,'customer_invoice',$2,$3,10000) RETURNING id`,
    [companyId, invoiceId, `r186-${randomUUID()}`],
  )).rows[0]!.id as string;
}

/** Runs `fn` in one transaction for `companyId`; commits only when asked. */
export async function drive<T>(companyId: string, fn: () => Promise<T>,
  opts: { commit?: boolean; appUser?: boolean } = {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opts.appUser) {
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    }
    const out = await als.run({ client, userId: user, companyId, claims: {} }, fn);
    await client.query(opts.commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The error a run threw (code, constraint), or {} when it completed. */
export async function failureOf(companyId: string, fn: () => Promise<unknown>,
  appUser = false): Promise<{ code?: string; constraint?: string }> {
  try {
    await drive(companyId, fn, { commit: true, appUser });
    return {};
  } catch (err) {
    return { code: (err as { code?: string }).code, constraint: (err as { constraint?: string }).constraint };
  }
}

export async function ids(sqlText: string, params: unknown[]): Promise<string[]> {
  return (await pool.query(sqlText, params)).rows.map((r) => r.id as string).sort();
}

export async function cleanup(companies: string[]): Promise<void> {
  try {
    for (const id of companies) {
      for (const t of ['paystack_payment_requests', 'stitch_payment_requests', 'archive_customer_invoices', 'archive_runs',
        'audit_log', 'customer_invoices', 'customers', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id=$1`, [id]);
      }
      await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
}
