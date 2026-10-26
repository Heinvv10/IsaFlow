/**
 * Void after refund (Hein's ruling 2026-10-26, breaker REPRO 3 of #838): a void of a supplier payment whose cash a
 * refund has already returned is REFUSED, before any write — it would leave the supplier owing the company (on-account
 * credit below zero). Voiding takes the payment's unapplied remainder off that credit; a fully applied payment, or a
 * refund, takes nothing off it. A bank-rule run undo that reverses the payment AND its refund together stays legal,
 * whichever row it reaches first; one whose refund row is skipped leaves the payment refused and the run open.
 *
 * Every void path cancels through one of two writers: `voidSupplierPayment`'s own flip, or
 * `bank/bankAllocationUnwind.unwindOnePayment` (bank reverse, chain reversal, MCP void_payment, run undo).
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { getSupplierOnAccountCredit } from '@/modules/accounting/services/ap/supplierOnAccountCredit';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { applySupplierPaymentPlan, planSupplierPaymentApplication } from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import { unwindOnePayment } from '@/modules/accounting/services/bank/bankAllocationUnwind';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';
import { outcomeOf } from './ap-supplier-batch-lock-order.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let fx: K074Fixture;
beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => {
  try {
    await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM bank_auto_post_runs WHERE company_id = $1', [fx.company]);
    await cleanupK074(pool, fx);
  } finally { await pool.end(); }
});

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function newSupplier(): Promise<string> {
  const supplier = crypto.randomUUID();
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, fx.company, `VAR ${supplier.slice(0, 6)}`]);
  return supplier;
}

async function bill(supplier: string, total: number): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,
       total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,$5::DATE - 10,$5::DATE + 20,$6,0,$6,0,'approved',$7)`,
    [id, fx.company, supplier, `VAR-${id.slice(0, 8)}`, DAY, total, fx.user]);
  return id;
}

/** A processed payment with its own posted journal (no bank line), as the payments screen leaves one. */
async function posted(supplier: string, amount: number): Promise<string> {
  const { rows: [je] } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,status,created_by,fiscal_period_id,posted_at)
     VALUES($1,$2,$3::DATE,'VAR payment','posted',$4,(SELECT id FROM fiscal_periods WHERE company_id = $1 LIMIT 1),NOW())
     RETURNING id`, [fx.company, `JE-VAR-${crypto.randomUUID().slice(0, 8)}`, DAY, fx.user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id)
     VALUES($1,$2,$4,0,$5),($1,$3,0,$4,$5)`, [je.id, fx.apAccount, fx.bankAccount, amount, fx.company]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,
       reference,status,gl_journal_entry_id,created_by,approved_by,approved_at,processed_at)
     VALUES($1,$2,$3::DATE,$4,'eft',$5,'VAR','processed',$6,$7,$7,NOW(),NOW()) RETURNING id`,
    [fx.company, supplier, DAY, amount, fx.bankAccount, je.id, fx.user]);
  return String(p.id);
}

/** The refund as the bank paths take it: the plan (ceiling + credit key), then the row. */
const refundBody = (supplier: string, amount: number) => async () => {
  await planSupplierRefund(fx.company, supplier, amount, DAY);
  const { client } = als.getStore() as unknown as { client: { query: (q: string, p: unknown[]) => Promise<unknown> } };
  await client.query(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,
       reference,status,created_by,approved_by,approved_at,processed_at)
     VALUES($1,$2,$3::DATE,$4,'refund',$5,'VAR refund','processed',$6,$6,NOW(),NOW())`,
    [fx.company, supplier, DAY, -amount, fx.bankAccount, fx.user]);
};
const refund = (supplier: string, amount: number) => inTx(refundBody(supplier, amount));

/** `fn` in a transaction held OPEN after it ran (its locks and the credit key held) until `release()`. */
function heldTx(fn: () => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ran!: (v: { ok: boolean }) => void;
  const done = new Promise<{ ok: boolean }>((r) => { ran = r; });
  const finished = (async () => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const o = await outcomeOf(als.run({ client, userId: fx.user, companyId: fx.company, claims: {} } as never, fn));
      ran(o);
      await gate;
      await client.query(o.ok ? 'COMMIT' : 'ROLLBACK');
    } finally { client.release(); }
  })();
  return { done, release, finished };
}

const credit = async (supplier: string) =>
  (await inTx(() => getSupplierOnAccountCredit(fx.company, supplier, null))).credit;
const statusOf = async (paymentId: string) =>
  String((await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [paymentId])).rows[0].status);
const verdict = async (p: Promise<unknown>) => { const o = await outcomeOf(p); return o.ok ? 'passed' : o.code; };

/** A bank line of `amount` (negative = paid out) allocated to `supplier` on account; returns line and payment ids. */
async function bankAllocated(supplier: string, amount: number, id: string = crypto.randomUUID()) {
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,$4::DATE,$5,'VAR line','imported')`, [id, fx.company, fx.bankAccount, DAY, amount]);
  const { journalEntryId } = await inTx(() => allocateTransaction(
    fx.company, id, null, fx.user, 'VAR', 'supplier', supplier,
    undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' }));
  const { rows: [p] } = await pool.query(
    'SELECT id FROM supplier_payments WHERE gl_journal_entry_id = $1 AND company_id = $2', [journalEntryId, fx.company]);
  return { line: id, payment: String(p.id) };
}

describe('void of a supplier payment whose cash a refund returned', () => {
  it('is refused before any write (payments screen void)', async () => {
    const supplier = await newSupplier();
    const pay = await posted(supplier, 1000);
    await refund(supplier, 1000);
    expect({
      v: await verdict(inTx(() => voidSupplierPayment(fx.company, pay, fx.user))),
      status: await statusOf(pay), credit: await credit(supplier),
    }).toEqual({ v: 'SUPPLIER_PAYMENT_REFUSED', status: 'processed', credit: 0 });
  }, 60_000);

  it('passes when other cash still covers the refund', async () => {
    const supplier = await newSupplier();
    const pay = await posted(supplier, 1000);
    await posted(supplier, 1000);
    await refund(supplier, 1000);
    expect({ v: await verdict(inTx(() => voidSupplierPayment(fx.company, pay, fx.user))), credit: await credit(supplier) })
      .toEqual({ v: 'passed', credit: 0 });
  }, 60_000);

  it('passes for a fully applied payment even when the supplier is already below zero (it lowers nothing)', async () => {
    const supplier = await newSupplier();
    const b = await bill(supplier, 1000);
    const pay = await posted(supplier, 1000);
    await inTx(async () => applySupplierPaymentPlan(fx.company,
      await planSupplierPaymentApplication(fx.company, pay, [{ invoiceId: b, amount: 1000 }]), fx.user));
    // The Velocity shape: a refund row already taking the supplier below zero.
    await pool.query(
      `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,reference,status,created_by)
       VALUES($1,$2,$3::DATE,-500,'refund','VAR forged','processed',$4)`, [fx.company, supplier, DAY, fx.user]);
    expect({ v: await verdict(inTx(() => voidSupplierPayment(fx.company, pay, fx.user))), credit: await credit(supplier) })
      .toEqual({ v: 'passed', credit: -500 });
  }, 60_000);

  it('the shared unwind (bank reverse, MCP void, run undo) refuses before its first write', async () => {
    const supplier = await newSupplier();
    const pay = await posted(supplier, 1000);
    await refund(supplier, 1000);
    const inside = await inTx(async () => {
      const v = await verdict(unwindOnePayment(fx.company, 'supplier', pay));
      const { client } = als.getStore() as unknown as { client: { query: (q: string, p: unknown[]) => Promise<{ rows: { status: string }[] }> } };
      const seen = (await client.query('SELECT status FROM supplier_payments WHERE id = $1', [pay])).rows[0].status;
      return { v, seen };
    });
    expect(inside).toEqual({ v: 'SUPPLIER_PAYMENT_REFUSED', seen: 'processed' });
  }, 60_000);

  it('a void while a refund of the same cash is in flight is refused as retryable; once the refund commits, on the books', async () => {
    const supplier = await newSupplier();
    const pay = await posted(supplier, 1000);
    const r = heldTx(refundBody(supplier, 1000));
    const refunded = await r.done;
    const during = await verdict(inTx(() => voidSupplierPayment(fx.company, pay, fx.user)));
    r.release();
    await r.finished;
    const after = await verdict(inTx(() => voidSupplierPayment(fx.company, pay, fx.user)));
    expect({ refunded: refunded.ok, during, after, status: await statusOf(pay), credit: await credit(supplier) })
      .toEqual({ refunded: true, during: 'PAYMENT_LOCK_TIMEOUT', after: 'SUPPLIER_PAYMENT_REFUSED', status: 'processed', credit: 0 });
  }, 60_000);

  it('a refund while a void of the same cash is in flight is refused as retryable (credit never below zero)', async () => {
    const supplier = await newSupplier();
    const pay = await posted(supplier, 1000);
    const v = heldTx(() => voidSupplierPayment(fx.company, pay, fx.user));
    const voided = await v.done;
    const during = await verdict(refund(supplier, 1000));
    v.release();
    await v.finished;
    expect({ voided: voided.ok, during, credit: await credit(supplier) })
      .toEqual({ voided: true, during: 'PAYMENT_LOCK_TIMEOUT', credit: 0 });
  }, 60_000);

  it('the unwind of an already-cancelled payment (a hand-reversed run row) lowers nothing and passes', async () => {
    const supplier = await newSupplier();
    const pay = await posted(supplier, 1000);
    await refund(supplier, 1000);
    await pool.query(`UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1`, [pay]);
    expect({ v: await verdict(inTx(() => unwindOnePayment(fx.company, 'supplier', pay))), credit: await credit(supplier) })
      .toEqual({ v: 'passed', credit: -1000 });
  }, 60_000);

  it('a bank-line reverse of the payment is refused; reversing the refund first, then the payment, passes', async () => {
    const supplier = await newSupplier();
    const out = await bankAllocated(supplier, -1000);
    const back = await bankAllocated(supplier, 1000);
    const first = await verdict(inTx(() => reverseReconciledTransaction(fx.company, out.line, fx.user)));
    const refundFirst = await verdict(inTx(() => reverseReconciledTransaction(fx.company, back.line, fx.user)));
    const thenPayment = await verdict(inTx(() => reverseReconciledTransaction(fx.company, out.line, fx.user)));
    expect({ first, refundFirst, thenPayment, pay: await statusOf(out.payment), credit: await credit(supplier) })
      .toEqual({ first: 'SUPPLIER_PAYMENT_REFUSED', refundFirst: 'passed', thenPayment: 'passed', pay: 'cancelled', credit: 0 });
  }, 60_000);

  async function run(lines: string[]): Promise<string> {
    const { rows: [r] } = await pool.query(
      `INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by, posted_count, total_amount)
       VALUES ($1,'categorization',0.9,0,$2,$3,0) RETURNING id`, [fx.company, fx.user, lines.length]);
    await pool.query('UPDATE bank_transactions SET auto_post_run_id = $1 WHERE id = ANY($2::UUID[])', [r.id, lines]);
    return String(r.id);
  }

  it('a run undo reversing the payment AND its refund passes, even reaching the payment first', async () => {
    const supplier = await newSupplier();
    // Ids ordered so the run (ORDER BY id) reaches the payment's line before the refund's.
    const out = await bankAllocated(supplier, -1000, `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`);
    const back = await bankAllocated(supplier, 1000, `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`);
    const runId = await run([out.line, back.line]);
    const result = await inTx(() => undoRun(fx.company, runId, fx.user));
    expect({ reversed: result.reversed, undone: result.undone, pay: await statusOf(out.payment), credit: await credit(supplier) })
      .toEqual({ reversed: 2, undone: true, pay: 'cancelled', credit: 0 });
  }, 60_000);

  it('a run undo whose refund is not in the run leaves the payment refused and the run open', async () => {
    const supplier = await newSupplier();
    const out = await bankAllocated(supplier, -1000);
    await bankAllocated(supplier, 1000);
    const runId = await run([out.line]);
    const result = await inTx(() => undoRun(fx.company, runId, fx.user));
    expect({ reversed: result.reversed, undone: result.undone, refused: result.skippedBy.creditCeiling,
      pay: await statusOf(out.payment), credit: await credit(supplier) })
      .toEqual({ reversed: 0, undone: false, refused: 1, pay: 'processed', credit: 0 });
  }, 60_000);
});
