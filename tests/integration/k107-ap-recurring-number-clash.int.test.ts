/**
 * MEDIUM-3 — a single pre-existing bill must not wedge a company's AP
 * recurring templates forever.
 *
 * The AP branch reserves from the 'supplier_invoice' sequence. If one bill
 * already holds SIV0000001 and the INSERT has no savepointed retry, the run
 * raises 23505; the route answers 4xx, `withAuth` COMMITs an aborted
 * transaction (a silent ROLLBACK), the reservation goes back, and the next run
 * reserves the SAME number and fails identically. Every run, forever, reported
 * as a generic 400.
 *
 * These cases assert the retry takes the next free number instead, that the
 * sequence really advanced, and that a run whose template does not exist is
 * still refused BEFORE any write — the only failure a 4xx may answer.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { executeRecurring } from '../../src/modules/accounting/services/core/recurringTransactionService';
import { RecurringTemplateNotFoundError } from '../../src/modules/accounting/services/core/recurringTransactionErrors';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const supplier = crypto.randomUUID();
const apTemplate = crypto.randomUUID();

async function apNext(): Promise<number> {
  const r = await pool.query(
    "SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type='supplier_invoice'",
    [company]);
  return Number(r.rows[0].next_number);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 AP clash']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'Wedge supplier']);
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,'Daily supply','supplier_invoice',$3,'daily',$4)`,
    [apTemplate, company, JSON.stringify({ supplierId: supplier, subtotal: 100, vatAmount: 15, totalAmount: 115 }), user]);
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('takes the next free number when a bill already holds the one the sequence offers', async () => {
  const taken = `SIV${String(await apNext()).padStart(7, '0')}`;
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,subtotal,tax_amount,total_amount,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01',100,15,115,$5)`,
    [crypto.randomUUID(), company, taken, supplier, user]);

  const before = await apNext();
  const first = await executeRecurring(company, apTemplate, user);
  expect.soft(first.entityType).toBe('supplier_invoice');

  const minted = await pool.query('SELECT invoice_number FROM supplier_invoices WHERE id=$1', [first.entityId]);
  // Skipped the taken number rather than failing on it.
  expect.soft(minted.rows[0].invoice_number).not.toBe(taken);
  expect.soft(minted.rows[0].invoice_number).toBe(`SIV${String(before + 1).padStart(7, '0')}`);
  // Two numbers consumed: the clash and the one that landed.
  expect(await apNext()).toBe(before + 2);
});

it('runs again the next day instead of wedging on the same number', async () => {
  const second = await executeRecurring(company, apTemplate, user);
  const bills = await pool.query(
    'SELECT count(*)::int AS n, count(DISTINCT invoice_number)::int AS distinct_numbers FROM supplier_invoices WHERE company_id=$1',
    [company]);
  expect.soft(second.entityId).toBeTruthy();
  // 1 seeded + 2 minted, every number distinct.
  expect.soft(bills.rows[0].n).toBe(3);
  expect(bills.rows[0].distinct_numbers).toBe(3);
});

it('refuses a missing template before writing anything, which is the only failure a 4xx may answer', async () => {
  const before = await apNext();
  await expect(executeRecurring(company, crypto.randomUUID(), user))
    .rejects.toBeInstanceOf(RecurringTemplateNotFoundError);
  expect(await apNext()).toBe(before);
});
