/**
 * Receipt void after refund through the MCP bulk reversals (`reverse_bank_allocation_batch`, `reverse_allocations`):
 * several receipts of ONE customer are judged TOGETHER (ar/customerVoidCredit) — each one alone may fit what a refund
 * left, and the pair not — and by date, so cancelling receipts whose removal leaves every date at zero or above is never
 * refused (a "sum against the lowest figure" rule would). A receipt and its refund in one call pass in either order
 * (the credit-last retry, bank/reverseLinesCreditLast). The range's dry run answers what the live call does, and
 * leaves its idempotency key unspent. All-or-nothing: a refusal reverses no line. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { reverseAllocationsTool } from '@/lib/mcp/tools/writeBankReverseRange';
import { reverseBankAllocationBatchTool } from '@/lib/mcp/tools/writeBankReverseBatch';
import { createAllocationBatch, recordAllocationBatchLines } from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, type K074Fixture } from './helpers/k074Fixture';
import { receiptLedger, verdict } from './ar-receipt-void-after-refund.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let fx: K074Fixture;
const L = receiptLedger(pool, () => fx);
beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => {
  try {
    await pool.query('UPDATE bank_transactions SET allocation_batch_id = NULL WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM bank_allocation_batch_lines WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM bank_allocation_batches WHERE company_id = $1', [fx.company]);
    await cleanupK074(pool, fx);
  } finally { await pool.end(); }
});

type Posted = Awaited<ReturnType<typeof L.allocated>>;
async function batchOf(...lines: Posted[]): Promise<string> {
  return L.inTx(async () => {
    const id = await createAllocationBatch(fx.company, fx.user, { tool: 'bulk_allocate_bank_transactions', lineCount: lines.length, idempotencyKey: null });
    await recordAllocationBatchLines(fx.company, id, lines.map((l) => ({ transactionId: l.line, journalEntryId: l.journalEntryId })));
    return id;
  });
}
const reverseBatch = (batchId: string) => L.inTx(() => reverseBankAllocationBatchTool.handler(
  { batch_id: batchId, idempotency_key: crypto.randomUUID() }, L.ctx()));
const range = (from: string, to: string, dryRun: boolean, key = crypto.randomUUID()) => L.inTx(() => reverseAllocationsTool.handler(
  { bank_account_id: fx.bankAccount, from_date: from, to_date: to, idempotency_key: key, ...(dryRun ? { dry_run: true } : {}) }, L.ctx()));

describe('several receipts of one customer, reversed in one call', () => {
  it('two receipts that each fit what the refund left, but not together: the batch is refused whole', async () => {
    const c = await L.newCustomer();
    const r1 = await L.allocated(c, 300, '2026-05-05');
    const r2 = await L.allocated(c, 300, '2026-05-06');
    await L.allocated(c, -250, '2026-05-09'); // running credit 300, 600, 350
    // each alone: from 05-05 the lowest is 300, from 05-06 it is 350 — both cover 300; together they leave -250
    expect(await verdict(reverseBatch(await batchOf(r1, r2)))).toBe('RECEIPT_REFUSED');
    expect({ r1: await L.statusOf(r1.receipt), r2: await L.statusOf(r2.receipt), line1: await L.lineStatus(r1.line), credit: await L.credit(c) })
      .toEqual({ r1: 'confirmed', r2: 'confirmed', line1: 'allocated', credit: 350 });
  }, 60_000);

  it('the same pair through the range: the dry run refuses as the live call does, and neither reverses', async () => {
    const c = await L.newCustomer();
    const r1 = await L.allocated(c, 300, '2026-05-02');
    const r2 = await L.allocated(c, 300, '2026-05-03');
    await L.allocated(c, -250, '2026-05-04');
    expect(await verdict(range('2026-05-02', '2026-05-03', true))).toBe('RECEIPT_REFUSED');
    expect(await verdict(range('2026-05-02', '2026-05-03', false))).toBe('RECEIPT_REFUSED');
    expect([await L.statusOf(r1.receipt), await L.statusOf(r2.receipt), await L.credit(c)]).toEqual(['confirmed', 'confirmed', 350]);
  }, 60_000);

  it('a receipt and its refund in one batch reverse together (the receipt is retried after the refund)', async () => {
    const c = await L.newCustomer();
    // a low id for the receipt's line, so the batch reaches it while the refund still stands
    const r = await L.allocated(c, 400, '2026-05-07', 'none', `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`);
    const back = await L.allocated(c, -400, '2026-05-08', 'none', `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`);
    expect(await verdict(reverseBatch(await batchOf(r, back)))).toBe('passed');
    expect([await L.statusOf(r.receipt), await L.statusOf(back.receipt), await L.credit(c)]).toEqual(['cancelled', 'cancelled', 0]);
  }, 60_000);

  it('a receipt and its refund in one range: the dry run passes (judged together), its key stays free, the live call reverses both', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 450, '2026-05-12', 'none', `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`);
    const back = await L.allocated(c, -450, '2026-05-13', 'none', `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`);
    const key = crypto.randomUUID();
    const dry = await range('2026-05-12', '2026-05-13', true, key);
    expect({ ok: !dry.isError, wroteNothing: dry.wroteNothing, would: JSON.parse(dry.content[0]!.text).would_reverse })
      .toEqual({ ok: true, wroteNothing: true, would: 2 });
    expect(await verdict(range('2026-05-12', '2026-05-13', false, key))).toBe('passed');
    expect([await L.statusOf(r.receipt), await L.statusOf(back.receipt), await L.credit(c)]).toEqual(['cancelled', 'cancelled', 0]);
  }, 60_000);

  it('receipts on different dates whose removal leaves every date at zero are not refused (judged by date, not sum vs lowest)', async () => {
    const c = await L.newCustomer();
    const r1 = await L.allocated(c, 50, '2026-05-16');
    const r2 = await L.allocated(c, 100, '2026-05-18');
    // running 50, 150: R150 together exceeds the lowest figure from 05-16 (R50), yet nothing is left below zero
    expect(await verdict(range('2026-05-16', '2026-05-18', true))).toBe('passed');
    expect(await verdict(range('2026-05-16', '2026-05-18', false))).toBe('passed');
    expect([await L.statusOf(r1.receipt), await L.statusOf(r2.receipt), await L.credit(c)]).toEqual(['cancelled', 'cancelled', 0]);
  }, 60_000);
});
