/**
 * K-013 — a recurring run mints an APPROVED invoice with no lines and no GL.
 *
 * generateInvoiceFromRecurring INSERTed a customer_invoices header directly at
 * status='approved' (recurringInvoiceService.ts:131-143), never calling
 * approveCustomerInvoice. It wrote no customer_invoice_items and posted no
 * journal, then advanced the schedule (:145-150). The canonical approve path
 * (customerInvoiceApprovalService.ts:133-142) posts DR AR / CR Revenue / CR VAT
 * on approve precisely because an approved invoice with a NULL
 * gl_journal_entry_id puts AR and the GL out of agreement by the invoice total.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { generateInvoiceFromRecurring } from '../../src/modules/accounting/services/ar/recurringInvoiceService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const other = crypto.randomUUID();
const template = crypto.randomUUID(), emptyTemplate = crypto.randomUUID();
const period = crypto.randomUUID();
const arAcc = crypto.randomUUID(), revAcc = crypto.randomUUID(), vatAcc = crypto.randomUUID();
let generated = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [company, 'K013 recurring fixture', other, 'K013 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K013 customer']);
  await pool.query(
    "INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'K013 year',1,2026,'2026-01-01','2026-12-31','open')",
    [period, company]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES
      ($1,$4,'K1100','Accounts receivable','asset','receivable','debit',true,true),
      ($2,$4,'K4000','Sales','revenue','default_revenue','credit',true,true),
      ($3,$4,'K2200','VAT output','liability','vat_output','credit',true,true)`,
    [arAcc, revAcc, vatAcc, company]);
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 monthly retainer',$3,'monthly','2026-03-01','Monthly retainer',
      $4::jsonb,1000,15,150,1150,$5,'active')`,
    [template, company, customer, JSON.stringify([{ description: 'Monthly retainer', quantity: 1, unitPrice: 1000 }]), user]);
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 empty template',$3,'monthly','2026-03-01','Empty',
      '[]'::jsonb,0,15,0,0,$4,'active')`,
    [emptyTemplate, company, customer, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('generates an approved invoice that carries its lines and its GL journal', async () => {
  generated = await generateInvoiceFromRecurring(company, template, user);

  const inv = (await pool.query(
    'SELECT status, total_amount::text AS total, gl_journal_entry_id FROM customer_invoices WHERE id=$1', [generated])).rows[0];
  expect(inv.status).toBe('approved');
  expect(inv.total).toBe('1150.00');

  const items = await pool.query(
    'SELECT count(*)::int AS n, sum(amount)::text AS total FROM customer_invoice_items WHERE invoice_id=$1', [generated]);
  expect(items.rows[0].n).toBe(1);
  expect(Number(items.rows[0].total)).toBe(1000);

  expect(inv.gl_journal_entry_id).not.toBeNull();
  const posted = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND status='posted'", [company]);
  expect(posted.rows[0].n).toBe(1);

  // The journal balances AND its receivable leg equals the invoice total.
  const lines = (await pool.query(
    `SELECT ga.account_subtype AS subtype, l.debit::float AS debit, l.credit::float AS credit
     FROM gl_journal_lines l JOIN gl_accounts ga ON ga.id = l.gl_account_id
     WHERE l.journal_entry_id=$1`, [inv.gl_journal_entry_id])).rows;
  const sum = (k: 'debit' | 'credit') => lines.reduce((s: number, r: Record<string, number>) => s + Number(r[k] || 0), 0);
  expect(sum('debit')).toBeCloseTo(sum('credit'), 2);
  expect(sum('debit')).toBeCloseTo(1150, 2);
  const receivable = lines.filter((r: { subtype: string }) => r.subtype === 'receivable');
  expect(receivable).toHaveLength(1);
  expect(Number(receivable[0].debit)).toBeCloseTo(1150, 2);
  expect(lines.find((r: { subtype: string }) => r.subtype === 'default_revenue').credit).toBeCloseTo(1000, 2);
  expect(lines.find((r: { subtype: string }) => r.subtype === 'vat_output').credit).toBeCloseTo(150, 2);

  // The schedule advanced only after the invoice really existed.
  const ri = (await pool.query(
    'SELECT run_count, next_run_date::text AS next FROM recurring_invoices WHERE id=$1', [template])).rows[0];
  expect(Number(ri.run_count)).toBe(1);
  expect(ri.next).toBe('2026-04-01');
});

it('refuses a template with no line items and leaves the schedule untouched', async () => {
  await expect(generateInvoiceFromRecurring(company, emptyTemplate, user)).rejects.toThrow(/no line items/);

  const n = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Empty'", [company]);
  expect(n.rows[0].n).toBe(0);
  const ri = (await pool.query('SELECT run_count, last_run_date FROM recurring_invoices WHERE id=$1', [emptyTemplate])).rows[0];
  expect(Number(ri.run_count)).toBe(0);
  expect(ri.last_run_date).toBeNull();
});

it('does not advance another tenant view of the template', async () => {
  await expect(generateInvoiceFromRecurring(other, template, user)).rejects.toThrow(/not found/i);
  const ri = (await pool.query('SELECT run_count FROM recurring_invoices WHERE id=$1', [template])).rows[0];
  expect(Number(ri.run_count)).toBe(1);
});

it('rolls the header back inside the request transaction when approval cannot post', async () => {
  // The batch runner catches per template and carries on, committing the shared
  // request transaction at the end. Deactivating the revenue role makes the
  // canonical approve path refuse; the savepoint must take the header and its
  // lines with it, so the surviving transaction holds nothing half-built.
  const t2 = crypto.randomUUID();
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 blocked',$3,'monthly','2026-03-01','Blocked',$4::jsonb,500,15,75,575,$5,'active')`,
    [t2, company, customer, JSON.stringify([{ description: 'Blocked line', quantity: 1, unitPrice: 500 }]), user]);
  await pool.query('UPDATE gl_accounts SET account_subtype=NULL WHERE id=$1', [revAcc]);
  clearSystemAccountCache(company);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
    await expect(als.run(ctx, () => generateInvoiceFromRecurring(company, t2, user))).rejects.toThrow();

    // The transaction is still usable — the caught failure did not poison it —
    // and it carries no trace of the blocked invoice.
    const left = await client.query(
      "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Blocked'", [company]);
    expect(left.rows[0].n).toBe(0);
    const orphanItems = await client.query(
      `SELECT count(*)::int AS n FROM customer_invoice_items i
       WHERE NOT EXISTS (SELECT 1 FROM customer_invoices ci WHERE ci.id = i.invoice_id)`);
    expect(orphanItems.rows[0].n).toBe(0);
    await client.query('COMMIT');
  } finally {
    client.release();
    await pool.query("UPDATE gl_accounts SET account_subtype='default_revenue' WHERE id=$1", [revAcc]);
    clearSystemAccountCache(company);
  }

  // Committed: nothing persisted, and the schedule never advanced.
  const after = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Blocked'", [company]);
  expect(after.rows[0].n).toBe(0);
  const ri = (await pool.query('SELECT run_count FROM recurring_invoices WHERE id=$1', [t2])).rows[0];
  expect(Number(ri.run_count)).toBe(0);
});
