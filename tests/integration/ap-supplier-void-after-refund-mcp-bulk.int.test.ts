/**
 * Void after refund through the MCP bulk reversals (`reverse_bank_allocation_range` / `_batch`): lines reverse in id
 * order, so a supplier payment's line can come before its refund's and be refused only because the refund still
 * stands. Reversing both is legal (credit back where it was), so the payment is retried after the rest
 * (`bank/reverseLinesCreditLast`) and the call stays all-or-nothing. The range's dry run decides the same refusal up
 * front. Breaker repros B8/B9 of the review of ca08c97f3 (red there, green with the parent's source). Disposable
 * fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getSupplierOnAccountCredit } from '@/modules/accounting/services/ap/supplierOnAccountCredit';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { reverseAllocationsTool } from '@/lib/mcp/tools/writeBankReverseRange';
import { reverseBankAllocationBatchTool } from '@/lib/mcp/tools/writeBankReverseBatch';
import { createAllocationBatch, recordAllocationBatchLines } from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';
import { outcomeOf } from './ap-supplier-batch-lock-order.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let fx: K074Fixture;
beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => {
  try {
    await pool.query('UPDATE bank_transactions SET allocation_batch_id = NULL WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM bank_allocation_batch_lines WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM bank_allocation_batches WHERE company_id = $1', [fx.company]);
    await cleanupK074(pool, fx);
  } finally { await pool.end(); }
});
/** Another day of DAY's month, outside a DAY..DAY range. */
const OTHER_DAY = `${DAY.slice(0, 8)}${DAY.slice(8) === '16' ? '17' : '16'}`;
/** A third day of the month, for the chain test's own range. */
const CHAIN_DAY = `${DAY.slice(0, 8)}${DAY.slice(8) === '20' ? '21' : '20'}`;

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
const credit = async (supplier: string) =>
  (await inTx(() => getSupplierOnAccountCredit(fx.company, supplier, null))).credit;
const statusOf = async (paymentId: string) =>
  String((await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [paymentId])).rows[0].status);
const verdict = async (p: Promise<unknown>) => { const o = await outcomeOf(p); return o.ok ? 'passed' : o.code; };

/** A bank line of `amount` (negative = paid out) allocated to `supplier` on account; its line and payment ids. */
async function bankAllocated(supplier: string, amount: number, id: string = crypto.randomUUID(), date: string = DAY) {
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,$4::DATE,$5,'VAR line','imported')`, [id, fx.company, fx.bankAccount, date, amount]);
  const { journalEntryId } = await inTx(() => allocateTransaction(
    fx.company, id, null, fx.user, 'VAR', 'supplier', supplier,
    undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' }));
  const { rows: [p] } = await pool.query(
    'SELECT id FROM supplier_payments WHERE gl_journal_entry_id = $1 AND company_id = $2', [journalEntryId, fx.company]);
  return { line: id, payment: String(p.id) };
}
const lowId = () => `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`;
const highId = () => `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`;

describe('MCP bulk reversal of a supplier payment AND its refund together', () => {
  it('reverse_bank_allocation_range over a payment and its refund: dry run says 2, live call reverses both', async () => {
    const s = await newSupplier();
    const out = await bankAllocated(s, -1000, lowId());
    const back = await bankAllocated(s, 1000, highId());
    const ctx = { companyId: fx.company, userId: fx.user, scopes: ['write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const args = { bank_account_id: fx.bankAccount, from_date: DAY, to_date: DAY, idempotency_key: crypto.randomUUID() };
    const dry = await inTx(() => reverseAllocationsTool.handler({ ...args, dry_run: true }, ctx as never)) as { content: { text: string }[] };
    const live = await verdict(inTx(() => reverseAllocationsTool.handler(args, ctx as never)));
    expect({ wouldReverse: JSON.parse(dry.content[0]!.text).would_reverse, live,
      pay: await statusOf(out.payment), refund: await statusOf(back.payment), credit: await credit(s) })
      .toEqual({ wouldReverse: 2, live: 'passed', pay: 'cancelled', refund: 'cancelled', credit: 0 });
  }, 60_000);

  it('reverse_bank_allocation_batch over a payment and its refund reverses both', async () => {
    const s2 = await newSupplier();
    const out = await bankAllocated(s2, -400, lowId());
    const back = await bankAllocated(s2, 400, highId());
    const je = async (l: string) => String((await pool.query(
      `SELECT jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
       WHERE bt.id = $1`, [l])).rows[0].journal_entry_id);
    const lines = [{ transactionId: out.line, journalEntryId: await je(out.line) }, { transactionId: back.line, journalEntryId: await je(back.line) }];
    const batchId = await inTx(async () => {
      const id = await createAllocationBatch(fx.company, fx.user, { tool: 'bulk_allocate_bank_transactions', lineCount: 2, idempotencyKey: null });
      await recordAllocationBatchLines(fx.company, id, lines);
      return id;
    });
    const ctx = { companyId: fx.company, userId: fx.user, scopes: ['write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const live = await verdict(inTx(() => reverseBankAllocationBatchTool.handler(
      { batch_id: batchId, idempotency_key: crypto.randomUUID() }, ctx as never)));
    expect({ live, pay: await statusOf(out.payment), refund: await statusOf(back.payment), credit: await credit(s2) })
      .toEqual({ live: 'passed', pay: 'cancelled', refund: 'cancelled', credit: 0 });
  }, 60_000);

  it('reverse_bank_allocation_range over a payment whose refund is outside the range: the dry run refuses as the live call does', async () => {
    const s3 = await newSupplier();
    const out = await bankAllocated(s3, -700, lowId());
    await bankAllocated(s3, 700, highId(), OTHER_DAY);
    const ctx = { companyId: fx.company, userId: fx.user, scopes: ['write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const args = { bank_account_id: fx.bankAccount, from_date: DAY, to_date: DAY, idempotency_key: crypto.randomUUID() };
    expect({
      dry: await verdict(inTx(() => reverseAllocationsTool.handler({ ...args, dry_run: true }, ctx as never))),
      live: await verdict(inTx(() => reverseAllocationsTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx as never))),
      pay: await statusOf(out.payment), credit: await credit(s3),
    }).toEqual({ dry: 'SUPPLIER_PAYMENT_REFUSED', live: 'SUPPLIER_PAYMENT_REFUSED', pay: 'processed', credit: 0 });
  }, 60_000);

  it('the range dry run finds a payment through its chain root (a line matched to a later member of the chain)', async () => {
    const s4 = await newSupplier();
    // Its own day: B10's refused payment line stays allocated on DAY and would answer for this one.
    const out = await bankAllocated(s4, -500, lowId(), CHAIN_DAY);
    // A refund outside the range has returned that cash: credit 0.
    await pool.query(
      `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,reference,status,created_by)
       VALUES($1,$2,$3::DATE,-500,'refund','VAR refund','processed',$4)`, [fx.company, s4, OTHER_DAY, fx.user]);
    // The statement line matched to a journal whose chain root is the payment's journal (planted: a member R of the
    // chain, reversal_of_id = the payment's journal), as a line matched to a re-reversal's head is.
    const { rows: [root] } = await pool.query(
      `SELECT jl.journal_entry_id AS id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
       WHERE bt.id = $1`, [out.line]);
    const { rows: [member] } = await pool.query(
      `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,status,created_by,fiscal_period_id,posted_at,reversal_of_id)
       VALUES($1,$2,$3::DATE,'VAR chain member','posted',$4,(SELECT id FROM fiscal_periods WHERE company_id = $1 LIMIT 1),NOW(),$5)
       RETURNING id`, [fx.company, `JE-VAR-${crypto.randomUUID().slice(0, 8)}`, CHAIN_DAY, fx.user, root.id]);
    const { rows: [bankLine] } = await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id)
       VALUES($1,$2,0,500,$3),($1,$4,500,0,$3) RETURNING id`, [member.id, fx.bankAccount, fx.company, fx.apAccount]);
    await pool.query('UPDATE bank_transactions SET matched_journal_line_id = $1 WHERE id = $2', [bankLine.id, out.line]);
    const ctx = { companyId: fx.company, userId: fx.user, scopes: ['write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const args = { bank_account_id: fx.bankAccount, from_date: CHAIN_DAY, to_date: CHAIN_DAY, idempotency_key: crypto.randomUUID(), dry_run: true };
    expect(await verdict(inTx(() => reverseAllocationsTool.handler(args, ctx as never)))).toBe('SUPPLIER_PAYMENT_REFUSED');
  }, 60_000);
});
