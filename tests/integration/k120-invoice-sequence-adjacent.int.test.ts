/**
 * K-120 adjacent cases for the two paths that used to mint invoice numbers from
 * MAX(invoice_number)+1 instead of the company sequence.
 *
 * 1. Repeated sales-order conversions advance the company counter once each and
 *    mint the number the sequence would have issued; a second tenant's counter
 *    is untouched.
 * 2. When the number the sequence hands out is ALREADY taken by a legacy
 *    invoice, the savepointed retry mints the next one and leaves the request
 *    transaction usable — the case with no savepoint at all before this fix.
 * 3. The recurring-invoice runner mints from the same sequence.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { convertSalesOrderToInvoice } from '../../src/modules/accounting/services/ar/salesOrderWorkflowService';
import { generateInvoiceFromRecurring } from '../../src/modules/accounting/services/ar/recurringInvoiceService';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID();
const user = crypto.randomUUID(), customer = crypto.randomUUID();
const orderA = crypto.randomUUID(), orderB = crypto.randomUUID(), orderC = crypto.randomUUID();
const template = crypto.randomUUID(), period = crypto.randomUUID();
const arAcc = crypto.randomUUID(), revAcc = crypto.randomUUID(), vatAcc = crypto.randomUUID();

async function seedOrder(id: string, number: string) {
  await pool.query(
    `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01',1000,150,1150,'confirmed',$5)`,
    [id, company, number, customer, user]);
}

async function nextNumber(target = company): Promise<number> {
  const r = await pool.query(
    "SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
    [target]);
  return Number(r.rows[0].next_number);
}

/** One request: its own connection, its own transaction, its own ALS context. */
async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: company, claims: {} }, () => fn(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K120 adjacent', other, 'K120 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K120 customer']);
  await pool.query(
    "INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'K120 year',1,2026,'2026-01-01','2026-12-31','open')",
    [period, company]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES
      ($1,$4,'K1100','Accounts receivable','asset','receivable','debit',true,true),
      ($2,$4,'K4000','Sales','revenue','default_revenue','credit',true,true),
      ($3,$4,'K2200','VAT output','liability','vat_output','credit',true,true)`,
    [arAcc, revAcc, vatAcc, company]);
  await pool.query(
    `INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
     VALUES($1,$2,'K120 retainer',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Retainer',$4::jsonb,1000,15,150,1150,$5,'active')`,
    [template, company, customer, JSON.stringify([{ description: 'Retainer', quantity: 1, unitPrice: 1000 }]), user]);
  await ensureDocumentNumbers(company);
  await ensureDocumentNumbers(other);
  await seedOrder(orderA, 'K120A-SO-A');
  await seedOrder(orderB, 'K120A-SO-B');
  await seedOrder(orderC, 'K120A-SO-C');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_sales_orders WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('two sales-order conversions take two consecutive numbers from the sequence', async () => {
  const before = await nextNumber();
  const otherBefore = await nextNumber(other);

  const a = await convertSalesOrderToInvoice(company, orderA, user);
  const b = await convertSalesOrderToInvoice(company, orderB, user);

  const numbers = await pool.query(
    'SELECT id, invoice_number FROM customer_invoices WHERE id=ANY($1) ORDER BY invoice_number',
    [[a.invoiceId, b.invoiceId]]);

  expect.soft(numbers.rows.map((r) => r.invoice_number)).toEqual([
    `INV${String(before).padStart(7, '0')}`,
    `INV${String(before + 1).padStart(7, '0')}`,
  ]);
  expect.soft(await nextNumber()).toBe(before + 2);
  expect(await nextNumber(other)).toBe(otherBefore);
});

it('retries past a number a legacy invoice already holds, without poisoning the request transaction', async () => {
  const taken = `INV${String(await nextNumber()).padStart(7, '0')}`;
  await pool.query(
    `INSERT INTO customer_invoices(company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$3,'2026-01-01','2026-01-31',10,1.5,11.5,'draft',$4)`,
    [company, taken, customer, user]);

  const { invoiceId, stillUsable } = await inTx(async (client) => {
    const res = await convertSalesOrderToInvoice(company, orderC, user);
    // A 23505 raised outside a savepoint aborts the whole request transaction,
    // so this read is the proof that the retry unwound only the failed INSERT.
    const probe = await client.query('SELECT 1 AS ok');
    return { invoiceId: res.invoiceId, stillUsable: probe.rows[0].ok };
  });

  const minted = (await pool.query('SELECT invoice_number FROM customer_invoices WHERE id=$1', [invoiceId])).rows[0].invoice_number;
  expect.soft(minted).not.toBe(taken);
  expect.soft(stillUsable).toBe(1);
  expect(minted).toMatch(/^INV\d{7}$/);
});

it('the recurring runner mints its invoice from the same sequence', async () => {
  const before = await nextNumber();
  const invoiceId = await inTx(() => generateInvoiceFromRecurring(company, template, user));

  const minted = (await pool.query('SELECT invoice_number FROM customer_invoices WHERE id=$1', [invoiceId])).rows[0].invoice_number;
  expect.soft(minted).toBe(`INV${String(before).padStart(7, '0')}`);
  expect(await nextNumber()).toBe(before + 1);
});
