/**
 * Bank controls step 2 (Hein, decision 4): agents may not reverse a bank
 * allocation whose arm's type is enforced. Every MCP reverse tool refuses
 * BEFORE any write — and reverse_allocations' dry run gives the same refusal
 * as its live call — so nothing is unwound; with enforcement off they reverse
 * as before. A customer receipt is money in: an agent still reverses it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { allocateBankTransactionTool, reverseBankAllocationTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { reverseBankAllocationBatchTool } from '../../src/lib/mcp/tools/writeBankReverseBatch';
import { reverseAllocationsTool } from '../../src/lib/mcp/tools/writeBankReverseRange';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import {
  bankCompany, cleanupBankControlsA, enforce, lineStatus, mcpCaller, PAY_TYPES, plantBatch, plantLine, type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
const mcp = mcpCaller(pool, [allocateBankTransactionTool, reverseBankAllocationTool, bulkAllocateBankTransactionsTool,
  reverseBankAllocationBatchTool, reverseAllocationsTool]);
const AGENT = 'Only a person signed in as themselves can reverse a bank allocation while approval is on; an agent or a job cannot.';
let seq = 0;
const key = () => `bc-a-rev-${Date.now()}-${seq++}`;

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [a]));

/** Two lines of a legacy batch allocated by the agent in one bulk call (the batch id returned), then `types` enforced. */
async function allocatedByAgent(types: string[], arm: 'account' | 'customer' = 'account') {
  const f: BankCompany = await bankCompany(pool, [[a, 'admin']], companies);
  const batch = await plantBatch(pool, f, null);
  const lines = [await plantLine(pool, f, batch, arm === 'customer' ? 300 : -300), await plantLine(pool, f, batch, arm === 'customer' ? 400 : -400)];
  const allocations = lines.map((id) => (arm === 'customer'
    ? { transaction_id: id, alloc_type: 'customer', entity_id: f.customer }
    : { transaction_id: id, alloc_type: 'account', contra_account_id: f.expA }));
  const res = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { allocations, idempotency_key: key() });
  expect(res.isError, res.content[0]!.text).toBeFalsy();
  await enforce(pool, f.c, a, types);
  return { f, lines, batchId: (JSON.parse(res.content[0]!.text) as { batch_id: string }).batch_id };
}
const range = (f: BankCompany, dry: boolean) => mcp(a, f.c, 'reverse_allocations', {
  bank_account_id: f.bank, from_date: '2026-09-01', to_date: '2026-09-30', dry_run: dry, idempotency_key: key() });
const statuses = (ids: string[]) => Promise.all(ids.map((id) => lineStatus(pool, id)));

describe('under enforcement an agent reverses nothing', () => {
  it('reverse_bank_allocation, reverse_bank_allocation_batch and reverse_allocations (dry run and live) refuse alike', async () => {
    const { f, lines, batchId } = await allocatedByAgent(['manual_journal']);
    const replies = [
      await mcp(a, f.c, 'reverse_bank_allocation', { transaction_id: lines[0], idempotency_key: key() }),
      await mcp(a, f.c, 'reverse_bank_allocation_batch', { batch_id: batchId, idempotency_key: key() }),
      await range(f, true),
      await range(f, false),
    ];
    for (const r of replies) {
      expect(r.isError, r.content[0]!.text).toBe(true);
      expect(r.content[0]!.text).toBe(AGENT);
    }
    expect(await statuses(lines)).toEqual(['allocated', 'allocated']);
  });

  it('supplier_payment enforced gates a supplier payment\'s reversal by an agent', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await plantLine(pool, f, await plantBatch(pool, f, null));
    const paid = await mcp(a, f.c, 'allocate_bank_transaction', {
      transaction_id: line, alloc_type: 'supplier', entity_id: f.supplier, idempotency_key: key() });
    expect(paid.isError, paid.content[0]!.text).toBeFalsy();
    await enforce(pool, f.c, a, PAY_TYPES);
    const r = await mcp(a, f.c, 'reverse_bank_allocation', { transaction_id: line, idempotency_key: key() });
    expect(r.content[0]!.text).toBe(AGENT);
    expect(await lineStatus(pool, line)).toBe('allocated');
  });
});

describe('what agent refusal leaves alone', () => {
  it('enforcement off: the dry run lists the range, and every tool reverses as before', async () => {
    const { f, lines, batchId } = await allocatedByAgent([]);
    const dry = await range(f, true);
    expect(dry.isError, dry.content[0]!.text).toBeFalsy();
    expect((JSON.parse(dry.content[0]!.text) as { would_reverse: number }).would_reverse).toBe(2);
    const one = await mcp(a, f.c, 'reverse_bank_allocation', { transaction_id: lines[0], idempotency_key: key() });
    expect(one.isError, one.content[0]!.text).toBeFalsy();
    const rest = await mcp(a, f.c, 'reverse_bank_allocation_batch', { batch_id: batchId, idempotency_key: key() });
    expect(rest.isError, rest.content[0]!.text).toBeFalsy();
    expect(await statuses(lines)).toEqual(['imported', 'imported']);
  });

  it('only an ENFORCED arm is gated: a manual_journal allocation reverses under supplier_payment enforcement', async () => {
    const { f, lines } = await allocatedByAgent(PAY_TYPES);
    const live = await range(f, false);
    expect(live.isError, live.content[0]!.text).toBeFalsy();
    expect(await statuses(lines)).toEqual(['imported', 'imported']);
  });

  it('a customer receipt is money in: an agent reverses it with every type enforced', async () => {
    const { f, lines } = await allocatedByAgent(['manual_journal', ...PAY_TYPES], 'customer');
    const r = await mcp(a, f.c, 'reverse_bank_allocation', { transaction_id: lines[0], idempotency_key: key() });
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    expect(await lineStatus(pool, lines[0]!)).toBe('imported');
  });
});
