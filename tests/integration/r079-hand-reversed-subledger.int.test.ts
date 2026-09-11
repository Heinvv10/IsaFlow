/**
 * R-079 round 6 (review r5 MEDIUM-1). A hand reversal of an auto-posting
 * touches only the ledger: the payment document the posting minted and the
 * bill or invoice it settled still read as paid. When the undo finishes such
 * a line as `alreadyUndone`, it must unwind that application the way
 * `reverseReconciledTransaction` does before its contra — otherwise the run
 * closes with the subledger saying a bill is paid by a journal that is off
 * the books. Measured before the fix: payment `processed`, bill `paid`
 * `amount_paid 100`, allocation intact. The clean undo of the same shape ends
 * payment `cancelled`, bill `approved`, 0 allocations — so must this one.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { DAY, seedBill, seedInvoice } from './helpers/k074Fixture';
import {
  cleanupR079, inRequest, nets, postJournal, postViaRoute, seedAutoPostedLine, seedR079, type R079Fixture,
} from './helpers/r079Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'r079_subledger_int' });
let fx: R079Fixture;

beforeAll(async () => { fx = await seedR079(pool); });
afterAll(async () => {
  try { await cleanupR079(pool, fx); } finally { await pool.end(); }
});

const undo = (runId: string) => postViaRoute(pool, fx, { action: 'undo', runId });
const delta = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, b[k]! - a[k]!]));

async function reverse(journalId: string): Promise<void> {
  const { reverseJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
  await inRequest(pool, fx, () => reverseJournalEntry(fx.company, journalId, fx.user));
}

/**
 * A supplier auto-post the way bankRuleAutoPostLine leaves it: AP 100 / bank
 * 100, a `processed` supplier payment on that journal, applied to a bill.
 */
async function seedSupplierAutoPost(shape: 'provisional' | 'matched') {
  const posted = await seedAutoPostedLine(pool, fx, [
    { glAccountId: fx.apAccount, debit: 100, credit: 0 }, { glAccountId: fx.bankAccount, debit: 0, credit: 100 },
  ], shape);
  const bill = await seedBill(pool, fx, 100);
  const payment = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,payment_method,
       bank_account_id,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,$3,$4,$5,100,'eft',$6,'processed',$7,$8)`,
    [payment, fx.company, fx.supplier, `R079P-${payment.slice(0, 8)}`, DAY, fx.bankAccount, posted.je, fx.user]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,100)', [payment, bill]);
  await pool.query("UPDATE supplier_invoices SET amount_paid=100, status='paid' WHERE id=$1", [bill]);
  return { ...posted, bill, payment };
}

async function supplierState(payment: string, bill: string) {
  const { rows: p } = await pool.query('SELECT status FROM supplier_payments WHERE id=$1', [payment]);
  const { rows: b } = await pool.query('SELECT status, amount_paid::float8 AS amount_paid FROM supplier_invoices WHERE id=$1', [bill]);
  const { rows: a } = await pool.query('SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id=$1', [payment]);
  return { payment: p[0].status, bill: b[0].status, amountPaid: b[0].amount_paid, allocations: a[0].n };
}

it.each(['matched', 'provisional'] as const)('%s supplier auto-post, hand-reversed: the undo cancels the payment, reopens the bill, and closes the run', async (shape) => {
  const base = await nets(pool, fx);
  const { line, je, runId, bill, payment } = await seedSupplierAutoPost(shape);
  await reverse(je);
  expect(await supplierState(payment, bill)).toEqual({ payment: 'processed', bill: 'paid', amountPaid: 100, allocations: 1 });

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 0, alreadyUndone: 1, undone: true, handOffsets: [] });
  // The subledger now agrees with the ledger: the bill is open again.
  expect(await supplierState(payment, bill)).toEqual({ payment: 'cancelled', bill: 'approved', amountPaid: 0, allocations: 0 });
  expect(delta(base, await nets(pool, fx))).toEqual({ e1: 0, e2: 0, e3: 0, bank: 0 });
  const { rows } = await pool.query('SELECT status, auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  expect(rows[0]).toEqual({ status: 'imported', auto_post_run_id: null });
}, 60000);

it('matched supplier auto-post, untouched: the clean undo ends in the same subledger state', async () => {
  const { runId, bill, payment } = await seedSupplierAutoPost('matched');

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 1, undone: true });
  expect(await supplierState(payment, bill)).toEqual({ payment: 'cancelled', bill: 'approved', amountPaid: 0, allocations: 0 });
}, 60000);

/** The AR side: a customer receipt auto-post (bank 100 / AR 100) applied to an invoice. */
async function seedCustomerAutoPost() {
  const posted = await seedAutoPostedLine(pool, fx, [
    { glAccountId: fx.bankAccount, debit: 100, credit: 0 }, { glAccountId: fx.arAccount, debit: 0, credit: 100 },
  ], 'matched');
  const invoice = await seedInvoice(pool, fx, 100);
  const receipt = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,payment_method,
       bank_account_id,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,$3,$4,$5,100,'eft',$6,'confirmed',$7,$8)`,
    [receipt, fx.company, fx.customer, `R079R-${receipt.slice(0, 8)}`, DAY, fx.bankAccount, posted.je, fx.user]);
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,100)', [receipt, invoice]);
  await pool.query("UPDATE customer_invoices SET amount_paid=100, status='paid' WHERE id=$1", [invoice]);
  return { ...posted, invoice, receipt };
}

async function customerState(receipt: string, invoice: string) {
  const { rows: p } = await pool.query('SELECT status FROM customer_payments WHERE id=$1', [receipt]);
  const { rows: i } = await pool.query('SELECT status, amount_paid::float8 AS amount_paid FROM customer_invoices WHERE id=$1', [invoice]);
  const { rows: a } = await pool.query('SELECT count(*)::int AS n FROM customer_payment_allocations WHERE payment_id=$1', [receipt]);
  return { receipt: p[0].status, invoice: i[0].status, amountPaid: i[0].amount_paid, allocations: a[0].n };
}

it('customer receipt auto-post, hand-reversed: the undo cancels the receipt and reopens the invoice', async () => {
  const { je, runId, invoice, receipt } = await seedCustomerAutoPost();
  await reverse(je);
  const clean = await seedCustomerAutoPost();
  expect((await undo(clean.runId)).body.data).toMatchObject({ reversed: 1, undone: true });
  const expected = await customerState(clean.receipt, clean.invoice);
  expect(expected).toMatchObject({ receipt: 'cancelled', allocations: 0, amountPaid: 0 });

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 0, alreadyUndone: 1, undone: true });
  // Exactly the state the clean undo of the same shape leaves.
  expect(await customerState(receipt, invoice)).toEqual(expected);
}, 60000);

it('a hand-reversed posting with a later reclass still unwinds — the reclass is not a blocker for it', async () => {
  const { je, runId, bill, payment } = await seedSupplierAutoPost('matched');
  await reverse(je);
  await postJournal(pool, fx, [{ glAccountId: fx.apAccount, debit: 0, credit: 30 }, { glAccountId: fx.e3, debit: 30, credit: 0 }]);

  expect((await undo(runId)).body.data).toMatchObject({ alreadyUndone: 1, undone: true, handOffsets: [] });
  expect(await supplierState(payment, bill)).toEqual({ payment: 'cancelled', bill: 'approved', amountPaid: 0, allocations: 0 });
}, 60000);
