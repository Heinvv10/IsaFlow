/**
 * K-107 — the recurring runner's number, and the barrier that number used to be.
 *
 * The reported defect: the number was `RINV-<slug>-<YYYYMM>`, constant for the
 * whole calendar month, so a daily or weekly AR template died on
 * uq_customer_invoices_company_number on its second run in the same month, and
 * the AP side (which had no unique index at all) minted an identical bill
 * instead — same number, same fingerprint — inflating payables and input VAT.
 *
 * Moving both onto the company sequence fixes that, and in doing so REMOVES the
 * only thing that stopped a repeat run: `executeRecurring` advanced
 * `next_run_date` at the end but never read it at the start, so a double-click,
 * a client retry or a re-POST would now mint a second real document silently.
 * The guard has to fail in BOTH directions, so this file asserts both:
 *
 *   - a second run while the schedule has not come round is refused, before any
 *     write, with nothing minted and the counter untouched;
 *   - a run that IS genuinely due — the next day — succeeds, in the same
 *     calendar month, with a distinct number. That is the original K-107 claim.
 *
 * The race between those two is closed by the template row lock, proved here
 * with two pool clients in two open transactions.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { executeRecurring } from '../../src/modules/accounting/services/core/recurringTransactionService';
import { RecurringTemplateNotDueError } from '../../src/modules/accounting/services/core/recurringTransactionErrors';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const customer = crypto.randomUUID();
const supplier = crypto.randomUUID();
const arTemplate = crypto.randomUUID();
const apTemplate = crypto.randomUUID();
const raceTemplate = crypto.randomUUID();

/** How long A holds its transaction open while B is parked on the template row. */
const HOLD_MS = 300;

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

/** Run inside a real request transaction, exactly as withAuth does. */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(ctxFor(client), fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The next day arriving, without waiting for it. */
async function makeDue(templateId: string) {
  await pool.query(
    'UPDATE recurring_transaction_templates SET next_run_date = CURRENT_DATE WHERE id=$1 AND company_id=$2',
    [templateId, company]);
}

async function nextNumber(type: string): Promise<number> {
  const r = await pool.query(
    'SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type=$2',
    [company, type]);
  return Number(r.rows[0].next_number);
}

async function seedTemplate(id: string, name: string, entityType: string, data: unknown) {
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,$3,$4,$5,'daily',$6)`,
    [id, company, name, entityType, JSON.stringify(data), user]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'Daily Retainer Client']);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'Daily Supplier']);
  const ar = { clientId: customer, subtotal: 100, vatAmount: 15, totalAmount: 115 };
  await seedTemplate(arTemplate, 'Daily retainer', 'customer_invoice', ar);
  await seedTemplate(raceTemplate, 'Daily race', 'customer_invoice', ar);
  await seedTemplate(apTemplate, 'Daily supply', 'supplier_invoice',
    { supplierId: supplier, subtotal: 100, vatAmount: 15, totalAmount: 115 });
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('refuses an immediate second AR run, minting nothing and burning no number', async () => {
  const before = await nextNumber('customer_invoice');
  await inTx(() => executeRecurring(company, arTemplate, user));

  // The double-click / client retry / re-POST. Before the schedule guard this
  // minted a SECOND real customer invoice with a fresh sequence number.
  await expect(inTx(() => executeRecurring(company, arTemplate, user)))
    .rejects.toBeInstanceOf(RecurringTemplateNotDueError);

  const rows = await pool.query(
    'SELECT invoice_number FROM customer_invoices WHERE company_id=$1', [company]);
  expect.soft(rows.rows.map((r) => r.invoice_number)).toEqual([`INV${String(before).padStart(7, '0')}`]);
  // Refused before the first write, so no reservation was made and rolled back.
  expect(await nextNumber('customer_invoice')).toBe(before + 1);
});

it('runs again the next day, in the same calendar month, with a distinct number', async () => {
  // The original K-107 claim. Under RINV-<slug>-<YYYYMM> this second run raised
  // 23505 on uq_customer_invoices_company_number, because the number carried the
  // month, not the day.
  const before = await nextNumber('customer_invoice');
  await makeDue(arTemplate);
  await inTx(() => executeRecurring(company, arTemplate, user));

  const rows = await pool.query(
    'SELECT invoice_number, invoice_date FROM customer_invoices WHERE company_id=$1 ORDER BY invoice_number', [company]);
  const numbers = rows.rows.map((r) => r.invoice_number);
  expect.soft(numbers).toHaveLength(2);
  expect.soft(new Set(numbers).size).toBe(2);
  expect.soft(numbers[1]).toBe(`INV${String(before).padStart(7, '0')}`);
  // Both in one month: same issue date, so the month token would have been equal.
  const months = new Set(rows.rows.map((r) => String(r.invoice_date).slice(0, 7)));
  expect(months.size).toBe(1);
});

it('refuses an immediate second AP run, and mints a distinct bill when the next day is due', async () => {
  const before = await nextNumber('supplier_invoice');
  await inTx(() => executeRecurring(company, apTemplate, user));

  // AP had NO unique index before migration 646, so a repeat run did not fail —
  // it minted an identical bill, same number, same duplicate_fingerprint.
  await expect(inTx(() => executeRecurring(company, apTemplate, user)))
    .rejects.toBeInstanceOf(RecurringTemplateNotDueError);
  const afterRefusal = await pool.query(
    'SELECT count(*)::int AS n FROM supplier_invoices WHERE company_id=$1', [company]);
  expect.soft(afterRefusal.rows[0].n).toBe(1);

  await makeDue(apTemplate);
  await inTx(() => executeRecurring(company, apTemplate, user));
  const bills = await pool.query(
    `SELECT count(*)::int AS n, count(DISTINCT invoice_number)::int AS numbers,
            count(DISTINCT duplicate_fingerprint)::int AS fingerprints
       FROM supplier_invoices WHERE company_id=$1`, [company]);
  expect.soft(bills.rows[0]).toEqual({ n: 2, numbers: 2, fingerprints: 2 });
  expect(await nextNumber('supplier_invoice')).toBe(before + 2);
});

it('serialises two simultaneous runs of one template on the template row lock', async () => {
  // The guard is a check-then-act: read `next_run_date`, then write. Without the
  // FOR UPDATE, two concurrent requests both read a due date and both mint. B
  // must BLOCK on A's uncommitted row and then re-read the advanced date.
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await als.run(ctxFor(a), () => executeRecurring(company, raceTemplate, user));

    let settled = false;
    const attempt = als.run(ctxFor(b), () => executeRecurring(company, raceTemplate, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    // A still holds the row: B cannot have decided anything yet.
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    await expect(attempt).rejects.toBeInstanceOf(RecurringTemplateNotDueError);
    await b.query('ROLLBACK');
  } finally {
    a.release(); b.release();
  }

  const minted = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Daily race'", [company]);
  expect(minted.rows[0].n).toBe(1);
});
