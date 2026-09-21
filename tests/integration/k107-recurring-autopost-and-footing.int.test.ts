/**
 * K-107 round 4 — the two holes the round-3 coverage left in the recurring run.
 *
 * 1. AUTO-POST WAS DEAD ON EVERY TENANT THAT TICKED IT. Both branches ended with
 *    `UPDATE ... SET status = 'posted'`, and 'posted' is not a value either
 *    status CHECK permits (customer: draft, pending_approval, approved, sent,
 *    paid, partially_paid, overdue, cancelled; supplier: draft,
 *    pending_approval, approved, partially_paid, paid, disputed, cancelled), so
 *    every run of an auto-post template raised 23514 and rolled back. No test in
 *    the previous rounds exercised auto_post at all. It now goes through the
 *    canonical approve path, which is what writes the journal behind the
 *    document — a bare status change would leave AR/AP and the GL apart by the
 *    document total.
 *
 * 2. THE DOCUMENT WAS NOT MADE TO FOOT. The header took subtotal/tax/total from
 *    the template's aggregate and the lines came from `templateData.lines`, with
 *    nothing reconciling them: a template whose lines came to R100 minted a
 *    header reading R9 999 / R11 499. The header is now DERIVED from the lines,
 *    and a stored aggregate that disagrees is refused rather than re-priced.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { executeRecurring } from '../../src/modules/accounting/services/core/recurringTransactionService';
import { RecurringTemplateTotalsMismatchError } from '../../src/modules/accounting/services/core/recurringTransactionErrors';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const customer = crypto.randomUUID(), supplier = crypto.randomUUID();
const period = crypto.randomUUID();
const arAcc = crypto.randomUUID(), revAcc = crypto.randomUUID(), vatOut = crypto.randomUUID();
const apAcc = crypto.randomUUID(), expAcc = crypto.randomUUID(), vatIn = crypto.randomUUID();
const arPost = crypto.randomUUID(), apPost = crypto.randomUUID();
const mismatch = crypto.randomUUID(), footing = crypto.randomUUID();

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
  try {
    await client.query('BEGIN');
    const out = await als.run(ctx, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function seedTemplate(id: string, name: string, entityType: string, autoPost: boolean, data: unknown) {
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,auto_post,created_by)
     VALUES($1,$2,$3,$4,$5,'daily',$6,$7)`,
    [id, company, name, entityType, JSON.stringify(data), autoPost, user]);
}

async function nextNumber(type: string): Promise<number> {
  const r = await pool.query(
    'SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type=$2',
    [company, type]);
  return Number(r.rows[0].next_number);
}

/** Debits and credits of the journal a document carries, in cents-exact numbers. */
async function journalOf(entryId: string) {
  const r = await pool.query(
    `SELECT COALESCE(sum(debit),0)::float8 AS dr, COALESCE(sum(credit),0)::float8 AS cr
       FROM gl_journal_lines WHERE journal_entry_id=$1`, [entryId]);
  return { dr: Number(r.rows[0].dr), cr: Number(r.rows[0].cr) };
}

const arLine = { description: 'Retainer', quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, accountId: revAcc };

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R4 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K107 R4 customer']);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'K107 R4 supplier']);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'K107 R4 year',1,EXTRACT(YEAR FROM CURRENT_DATE)::int,
            date_trunc('year',CURRENT_DATE)::date,(date_trunc('year',CURRENT_DATE)+INTERVAL '1 year -1 day')::date,'open')`,
    [period, company]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES
      ($1,$7,'R1100','Accounts receivable','asset','receivable','debit',true,true),
      ($2,$7,'R4000','Sales','revenue','default_revenue','credit',true,true),
      ($3,$7,'R2200','VAT output','liability','vat_output','credit',true,true),
      ($4,$7,'R2100','Accounts payable','liability','payable','credit',true,true),
      ($5,$7,'R6000','Expenses','expense','default_expense','debit',true,true),
      ($6,$7,'R2300','VAT input','asset','vat_input','debit',true,true)`,
    [arAcc, revAcc, vatOut, apAcc, expAcc, vatIn, company]);
  clearSystemAccountCache();

  await seedTemplate(arPost, 'K107 R4 AR auto-post', 'customer_invoice', true,
    { clientId: customer, subtotal: 100, vatAmount: 15, totalAmount: 115, lines: [arLine] });
  await seedTemplate(apPost, 'K107 R4 AP auto-post', 'supplier_invoice', true,
    {
      supplierId: supplier, subtotal: 100, vatAmount: 15, totalAmount: 115,
      lines: [{ ...arLine, accountId: expAcc }],
    });
  // The header the reviewer minted: R9 999 of aggregate over R100 of detail.
  await seedTemplate(mismatch, 'K107 R4 mismatch', 'customer_invoice', false,
    { clientId: customer, subtotal: 9999, vatAmount: 1500, totalAmount: 11499, lines: [arLine] });
  // NO stored aggregate: the header can only be right if it is DERIVED. A
  // template that carries an agreeing aggregate proves nothing — copying it
  // across and deriving it produce the same document, which is why the round-3
  // "both documents foot" assertion held over a fixture built to agree.
  await seedTemplate(footing, 'K107 R4 footing', 'customer_invoice', false,
    {
      clientId: customer,
      lines: [
        { description: 'A', quantity: 1, unitPrice: 200, taxRate: 15, lineTotal: 200, accountId: revAcc },
        { description: 'B', quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, accountId: revAcc },
      ],
    });
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('auto-posts a customer invoice into a status the CHECK allows, with the journal behind it', async () => {
  const result = await inTx(() => executeRecurring(company, arPost, user));
  expect.soft(result.posted).toBe(true);

  const inv = await pool.query(
    'SELECT status, subtotal::float8 AS s, tax_amount::float8 AS t, total_amount::float8 AS g, gl_journal_entry_id FROM customer_invoices WHERE id=$1',
    [result.entityId]);
  // 'posted' would have raised 23514 here; the run never got this far before.
  expect.soft(inv.rows[0].status).toBe('approved');
  expect.soft(inv.rows[0].gl_journal_entry_id).not.toBeNull();
  expect.soft([inv.rows[0].s, inv.rows[0].t, inv.rows[0].g]).toEqual([100, 15, 115]);

  // The journal balances AND agrees with the invoice: DR AR 115, CR revenue 100
  // + CR VAT output 15. An approved invoice with no journal is AR != GL.
  const { dr, cr } = await journalOf(String(inv.rows[0].gl_journal_entry_id));
  expect.soft(dr).toBe(cr);
  expect(dr).toBe(115);
});

it('auto-posts a supplier bill into a status the CHECK allows, with the journal behind it', async () => {
  const result = await inTx(() => executeRecurring(company, apPost, user));
  expect.soft(result.posted).toBe(true);

  const bill = await pool.query(
    'SELECT status, total_amount::float8 AS g, gl_journal_entry_id FROM supplier_invoices WHERE id=$1',
    [result.entityId]);
  expect.soft(bill.rows[0].status).toBe('approved');
  expect.soft(bill.rows[0].gl_journal_entry_id).not.toBeNull();
  expect.soft(bill.rows[0].g).toBe(115);

  const { dr, cr } = await journalOf(String(bill.rows[0].gl_journal_entry_id));
  expect.soft(dr).toBe(cr);
  expect(dr).toBe(115);
});

it('refuses a template whose stored aggregate disagrees with its lines, minting nothing', async () => {
  const beforeNumber = await nextNumber('customer_invoice');
  const before = await pool.query(
    'SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [company]);

  const err = await inTx(() => executeRecurring(company, mismatch, user))
    .then(() => null, (e: unknown) => e);
  expect.soft(err).toBeInstanceOf(RecurringTemplateTotalsMismatchError);
  expect.soft((err as Error).message).toContain('9999.00');

  const after = await pool.query(
    'SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [company]);
  expect.soft(after.rows[0].n).toBe(before.rows[0].n);
  // Refused before the first write, so no number was reserved and rolled back.
  expect.soft(await nextNumber('customer_invoice')).toBe(beforeNumber);
  // And the schedule did NOT advance: the template must run once it is fixed.
  const tpl = await pool.query('SELECT last_run_date FROM recurring_transaction_templates WHERE id=$1', [mismatch]);
  expect(tpl.rows[0].last_run_date).toBeNull();
});

it('derives the header from the lines, so the document foots', async () => {
  const result = await inTx(() => executeRecurring(company, footing, user));
  const inv = await pool.query(
    'SELECT subtotal::float8 AS s, tax_amount::float8 AS t, total_amount::float8 AS g FROM customer_invoices WHERE id=$1',
    [result.entityId]);
  const lines = await pool.query(
    `SELECT COALESCE(sum(amount),0)::float8 AS s,
            COALESCE(sum(round(amount * tax_rate / 100, 2)),0)::float8 AS t
       FROM customer_invoice_items WHERE invoice_id=$1`, [result.entityId]);
  expect.soft(inv.rows[0].s).toBe(lines.rows[0].s);
  expect.soft(inv.rows[0].t).toBe(lines.rows[0].t);
  expect.soft(inv.rows[0].g).toBe(lines.rows[0].s + lines.rows[0].t);
  expect([inv.rows[0].s, inv.rows[0].t, inv.rows[0].g]).toEqual([300, 45, 345]);
});
