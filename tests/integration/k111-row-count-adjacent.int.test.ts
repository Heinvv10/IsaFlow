// K-111 adjacent cases: the reported counts must be real, tenant-scoped, and
// honour the status predicate rather than the size of the id list.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { mergeEntities } from '../../src/modules/accounting/services/core/duplicateMergeService';
import { approveEntries, submitEntries } from '../../src/modules/accounting/services/core/timeTrackingService';
import { markAsInvoiced } from '../../src/modules/accounting/services/reports/timeTrackingReportService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const primary = crypto.randomUUID();
const duplicate = crypto.randomUUID();
const emptyPrimary = crypto.randomUUID();
const emptyDuplicate = crypto.randomUUID();
const otherInvoice = crypto.randomUUID();
const draftEntry = crypto.randomUUID();
const submittedEntry = crypto.randomUUID();
const nonBillableEntry = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K111 adj fixture', other, 'K111 adj second tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    'INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$9),($10,$11,$12)',
    [primary, company, 'Acme Pty Ltd', duplicate, company, 'ACME (Pty) Ltd',
      emptyPrimary, company, 'Nomad CC', emptyDuplicate, company, 'NOMAD cc']);
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,created_by,total_amount)
     VALUES($1,$2,'SI-ADJ-1',$3,'2026-08-01',$4,100)`,
    [crypto.randomUUID(), company, duplicate, user]);
  // Same supplier id referenced from another tenant's row must not be counted.
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [otherInvoice, other, 'Foreign supplier']);
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,created_by,total_amount)
     VALUES($1,$2,'SI-ADJ-X',$3,'2026-08-01',$4,50)`,
    [crypto.randomUUID(), other, otherInvoice, user]);
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,hours,status,entry_date)
     VALUES($1,$2,$3,'Draft work',2,'draft','2026-08-01'),($4,$2,$3,'Ready work',3,'submitted','2026-08-01')`,
    [draftEntry, company, user, submittedEntry]);
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,hours,status,entry_date,billable)
     VALUES($1,$2,$3,'Internal admin',1,'approved','2026-08-01',false)`,
    [nonBillableEntry, company, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM time_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM suppliers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('reports zero when the duplicate carries no documents at all', async () => {
  const result = await mergeEntities(company, 'supplier', emptyPrimary, emptyDuplicate, user);
  expect(result.reassignedTransactions).toBe(0);
});

it('counts only this tenant\'s rows and leaves the other tenant alone', async () => {
  const result = await mergeEntities(company, 'supplier', primary, duplicate, user);
  const foreign = await pool.query(
    'SELECT supplier_id FROM supplier_invoices WHERE company_id=$1', [other]);
  expect({ reported: result.reassignedTransactions, foreignSupplier: foreign.rows[0].supplier_id })
    .toEqual({ reported: 1, foreignSupplier: otherInvoice });
});

it('a repeated merge is refused because the duplicate is already soft-deleted', async () => {
  await expect(mergeEntities(company, 'supplier', primary, duplicate, user))
    .rejects.toThrow('One or both suppliers not found for this company');
});

it('counts the status predicate, not the length of the id list', async () => {
  const submitted = await submitEntries(company, [draftEntry, submittedEntry]);
  const approved = await approveEntries(company, [draftEntry, submittedEntry]);
  expect({ submitted, approved }).toEqual({ submitted: 1, approved: 2 });
});

it('marking as invoiced counts only the approved billable entries', async () => {
  const invoiceId = crypto.randomUUID();
  const marked = await markAsInvoiced(company, [draftEntry, submittedEntry, nonBillableEntry], invoiceId);
  const invoiced = await pool.query(
    "SELECT id FROM time_entries WHERE company_id=$1 AND status='invoiced'", [company]);
  expect({ marked, stored: invoiced.rows.length }).toEqual({ marked: 2, stored: 2 });
});
