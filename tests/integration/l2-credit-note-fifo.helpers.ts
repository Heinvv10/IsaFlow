/**
 * Fixture for the L2 credit-note FIFO integration tests.
 *
 * One disposable company per FILE, with its own supplier, customer, GL accounts
 * and fiscal period. Every document is created here through plain SQL rather
 * than through a service, so a defect in the services under test cannot make
 * the fixture describe something other than what it says.
 */
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';

export interface Fixture {
  pool: Pool;
  company: string;
  user: string;
  supplier: string;
  customer: string;
  /** Run `fn` as one request transaction, committing on success. */
  inTx<T>(fn: () => Promise<T>): Promise<T>;
  cleanup(): Promise<void>;
}

const ACCOUNTS: [string, string, string, string, string][] = [
  ['4000', 'Revenue', 'revenue', 'default_revenue', 'credit'],
  ['1200', 'Accounts Receivable', 'asset', 'receivable', 'debit'],
  ['2200', 'VAT Output', 'liability', 'vat_output', 'credit'],
  ['6000', 'Expense', 'expense', 'default_expense', 'debit'],
  ['2100', 'Accounts Payable', 'liability', 'payable', 'credit'],
  ['1140', 'VAT Input', 'asset', 'vat_input', 'debit'],
  ['1000', 'Bank', 'asset', 'bank', 'debit'],
];

export async function setupFixture(tag: string): Promise<Fixture> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const company = randomUUID();
  const user = randomUUID();
  const supplier = randomUUID();
  const customer = randomUUID();

  await pool.query('INSERT INTO companies(id,name,registration_number) VALUES($1,$2,$3)',
    [company, `${tag} co`, `${tag}-${Date.now()}`]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)',
    [supplier, company, `${tag} supplier`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',
    [customer, company, `${tag} customer`]);
  for (const [code, name, type, subtype, normal] of ACCOUNTS) {
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
         normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true)`,
      [company, code, `${tag} ${name}`, type, subtype, normal]);
  }
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'FY2026',1,2026,'2026-01-01','2026-12-31','open')`, [company]);

  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    const client: PoolClient = await pool.connect();
    await client.query('BEGIN');
    try {
      const out = await als.run(
        { client, userId: user, companyId: company, claims: {} } as never, fn,
      );
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function cleanup(): Promise<void> {
    try {
      const q = (text: string) => pool.query(text, [company]);
      await q(`DELETE FROM credit_note_allocations WHERE company_id=$1`);
      await q(`DELETE FROM credit_notes WHERE company_id=$1`);
      await q(`DELETE FROM supplier_payment_allocations WHERE payment_id IN
                 (SELECT id FROM supplier_payments WHERE company_id=$1)`);
      await q(`DELETE FROM payment_allocations WHERE payment_id IN
                 (SELECT id FROM supplier_payments WHERE company_id=$1)`);
      await q(`DELETE FROM supplier_payments WHERE company_id=$1`);
      await q(`DELETE FROM customer_payment_allocations WHERE payment_id IN
                 (SELECT id FROM customer_payments WHERE company_id=$1)`);
      await q(`DELETE FROM customer_payments WHERE company_id=$1`);
      await q(`DELETE FROM supplier_invoices WHERE company_id=$1`);
      await q(`DELETE FROM customer_invoices WHERE company_id=$1`);
      await q(`DELETE FROM gl_journal_lines WHERE company_id=$1`);
      await q(`DELETE FROM gl_journal_entries WHERE company_id=$1`);
      await q(`DELETE FROM gl_account_balances WHERE gl_account_id IN
                 (SELECT id FROM gl_accounts WHERE company_id=$1)`);
      await q(`DELETE FROM gl_accounts WHERE company_id=$1`);
      await q(`DELETE FROM fiscal_periods WHERE company_id=$1`);
      await q(`DELETE FROM suppliers WHERE company_id=$1`);
      await q(`DELETE FROM customers WHERE company_id=$1`);
      await q(`DELETE FROM company_users WHERE company_id=$1`);
      await pool.query('DELETE FROM companies WHERE id=$1', [company]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally {
      await pool.end();
    }
  }

  return { pool, company, user, supplier, customer, inTx, cleanup };
}

/** A posted supplier bill, open for the full amount. */
export async function makeBill(
  f: Fixture, number: string, total: number, invoiceDate: string,
): Promise<string> {
  const id = randomUUID();
  await f.pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,subtotal,total_amount,
       amount_paid,status,created_by,invoice_date)
     VALUES($1,$2,$3,$4,$5,$5,0,'approved',$6,$7)`,
    [id, f.company, number, f.supplier, total, f.user, invoiceDate]);
  return id;
}

/** A posted customer invoice, open for the full amount. */
export async function makeInvoice(
  f: Fixture, number: string, total: number, invoiceDate: string,
): Promise<string> {
  const id = randomUUID();
  await f.pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,
       total_amount,amount_paid,status,created_by,invoice_date)
     VALUES($1,$2,$3,$4,$4,$5,$5,0,'sent',$6,$7)`,
    [id, f.company, number, f.customer, total, f.user, invoiceDate]);
  return id;
}

/** A DRAFT credit note, ready for approveCreditNote. */
export async function makeDraftNote(
  f: Fixture,
  opts: {
    type: 'customer' | 'supplier';
    number: string;
    total: number;
    creditDate: string;
    linkedInvoiceId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const subtotal = Math.round((opts.total / 1.15) * 100) / 100;
  const tax = Math.round((opts.total - subtotal) * 100) / 100;
  await f.pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,supplier_id,
       customer_invoice_id,supplier_invoice_id,credit_date,subtotal,tax_rate,tax_amount,
       total_amount,status,created_by,applied_amount)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,15,$11,$12,'draft',$13,0)`,
    [
      id, f.company, opts.number, opts.type,
      opts.type === 'customer' ? f.customer : null,
      opts.type === 'supplier' ? f.supplier : null,
      opts.type === 'customer' ? (opts.linkedInvoiceId ?? null) : null,
      opts.type === 'supplier' ? (opts.linkedInvoiceId ?? null) : null,
      opts.creditDate, subtotal, tax, opts.total, f.user,
    ]);
  return id;
}

/**
 * An APPROVED note that has consumed nothing — the state a note is in between
 * its journal posting and an application. Used where a test needs to race the
 * application without racing the journal numbering.
 */
export async function makeApprovedNote(
  f: Fixture,
  opts: { type: 'customer' | 'supplier'; number: string; total: number; creditDate: string },
): Promise<string> {
  const id = await makeDraftNote(f, opts);
  await f.pool.query(
    `UPDATE credit_notes SET status = 'approved', approved_by = $2, approved_at = NOW()
     WHERE id = $1`, [id, f.user]);
  return id;
}

export async function billState(f: Fixture, id: string): Promise<{ paid: number; status: string }> {
  const { rows } = await f.pool.query(
    'SELECT amount_paid::float8 AS paid, status FROM supplier_invoices WHERE id=$1', [id]);
  return { paid: rows[0].paid as number, status: rows[0].status as string };
}

export async function invoiceState(f: Fixture, id: string): Promise<{ paid: number; status: string }> {
  const { rows } = await f.pool.query(
    'SELECT amount_paid::float8 AS paid, status FROM customer_invoices WHERE id=$1', [id]);
  return { paid: rows[0].paid as number, status: rows[0].status as string };
}

export async function noteState(
  f: Fixture, id: string,
): Promise<{ status: string; applied: number; allocations: { invoiceId: string; amount: number }[] }> {
  const { rows } = await f.pool.query(
    'SELECT status, applied_amount::float8 AS applied FROM credit_notes WHERE id=$1', [id]);
  const alloc = await f.pool.query(
    `SELECT invoice_id, amount_allocated::float8 AS amount FROM credit_note_allocations
     WHERE credit_note_id=$1 ORDER BY created_at, invoice_id`, [id]);
  return {
    status: rows[0].status as string,
    applied: rows[0].applied as number,
    allocations: alloc.rows.map((r) => ({ invoiceId: r.invoice_id as string, amount: r.amount as number })),
  };
}
