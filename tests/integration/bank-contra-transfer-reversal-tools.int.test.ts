/**
 * A transfer bulk-posted by MCP (an account line onto another bank — WP2 row 5) auto-links the other bank's line to
 * the same journal OUTSIDE the batch. Reversing it through reverse_bank_allocation_batch or reverse_allocations frees
 * that line too, by ONE mechanism: reverseReconciledTransaction's own leg reset (WP2 row 10, transferLegReset), which
 * the screen and reverse_bank_allocation share. The journal is reversed once; both lines come back to imported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, lineStatus, mcpCaller, type BankCompany } from './bank-controls-a.helpers';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { reverseBankAllocationBatchTool } from '../../src/lib/mcp/tools/writeBankReverseBatch';
import { reverseAllocationsTool } from '../../src/lib/mcp/tools/writeBankReverseRange';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
const mcp = mcpCaller(pool, [bulkAllocateBankTransactionsTool, reverseBankAllocationBatchTool, reverseAllocationsTool]);
const key = () => crypto.randomUUID();

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET allocation_batch_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const lineOn = async (f: BankCompany, bank: string, amount: number) => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
   VALUES($1,$2,DATE '2026-09-07',$3,'BCTR line','imported') RETURNING id`, [f.c, bank, amount])).rows[0].id as string;

async function bulkTransfer() {
  const f = await bankCompany(pool, [[a, 'admin']], companies);
  const out = await lineOn(f, f.bank, -615);
  const inn = await lineOn(f, f.bank2, 615); // auto-linked by the allocation, outside the batch
  const res = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { idempotency_key: key(),
    allocations: [{ transaction_id: out, alloc_type: 'account', contra_account_id: f.bank2 }] });
  expect(res.isError, res.content[0]!.text).toBeFalsy();
  const batchId = (JSON.parse(res.content[0]!.text) as { batch_id: string }).batch_id;
  const je = (await pool.query('SELECT transfer_journal_entry_id AS j FROM bank_transactions WHERE id = $1', [out])).rows[0].j as string;
  expect(await lineStatus(pool, inn), 'the counterpart was auto-linked').toBe('allocated');
  return { ...f, out, inn, je, batchId };
}
const reversals = async (je: string) => (await pool.query(
  "SELECT count(*)::INT AS n FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [je])).rows[0].n as number;

describe('the batch and range reversals free a bulk-posted transfer\'s other leg (one mechanism)', () => {
  it('reverse_bank_allocation_batch: journal reversed once, both lines imported', async () => {
    const t = await bulkTransfer();
    const out = await mcp(a, t.c, 'reverse_bank_allocation_batch', { batch_id: t.batchId, idempotency_key: key() });
    expect(out.isError, out.content[0]!.text).toBeFalsy();
    expect({ out: await lineStatus(pool, t.out), inn: await lineStatus(pool, t.inn), reversals: await reversals(t.je) })
      .toEqual({ out: 'imported', inn: 'imported', reversals: 1 });
  });

  it('reverse_allocations over the line\'s bank and date: journal reversed once, both lines imported', async () => {
    const t = await bulkTransfer();
    const out = await mcp(a, t.c, 'reverse_allocations', { bank_account_id: t.bank, from_date: '2026-09-07', to_date: '2026-09-07',
      idempotency_key: key() });
    expect(out.isError, out.content[0]!.text).toBeFalsy();
    expect({ out: await lineStatus(pool, t.out), inn: await lineStatus(pool, t.inn), reversals: await reversals(t.je) })
      .toEqual({ out: 'imported', inn: 'imported', reversals: 1 });
  });

  it('a counterpart a reconciliation holds refuses the batch reversal before any write', async () => {
    const t = await bulkTransfer();
    await pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [t.inn]); // Sage-reconciled
    const out = await mcp(a, t.c, 'reverse_bank_allocation_batch', { batch_id: t.batchId, idempotency_key: key() });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/other bank's line of this transfer/);
    expect({ out: await lineStatus(pool, t.out), inn: await lineStatus(pool, t.inn), reversals: await reversals(t.je) })
      .toEqual({ out: 'allocated', inn: 'reconciled', reversals: 0 });
  });
});
