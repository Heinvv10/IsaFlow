/**
 * PRD-11 §4 — reverse_bank_allocation_batch.
 *
 * The batch stamp says a row was PART of a batch; it does NOT say the journal
 * now on the row is the one the batch posted. Reversing whatever happens to be
 * there would unwind a posting this batch never made, so the tool reverses only
 * lines whose CURRENT journal is the recorded one and reports the rest as
 * skipped.
 *
 * registry.ts wraps every `write: true` tool in ONE `withSavepoint`, and that
 * savepoint rolls back only when the handler THROWS: a `catch → toolError`
 * returns normally, the savepoint RELEASES, and because the MCP transport
 * answers HTTP 200 for every tool result (isError included) bearerPipeline
 * COMMITs whatever the earlier lines already posted. A 500-line batch that
 * half-posts is exactly the failure these tools exist to avoid, so the
 * mid-batch rethrow is asserted directly rather than inferred.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationBatchService', () => ({
  createAllocationBatch: vi.fn(),
  recordAllocationBatchLines: vi.fn(),
  getAllocationBatchLines: vi.fn(),
  clearAllocationBatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(),
  suppliersBelongToCompany: vi.fn(),
}));

import {
  allocateTransaction,
  reverseReconciledTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';
import {
  createAllocationBatch,
  recordAllocationBatchLines,
  getAllocationBatchLines,
  clearAllocationBatch,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import {
  bulkAllocateBankTransactionsTool,
  reverseBankAllocationBatchTool,
} from '@/lib/mcp/tools/writeBankBulkAllocate';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const BATCH = '0f000000-0000-4000-8000-000000000001';
// Real UUIDs: every id on a line is a uuid column, and the parser refuses a
// malformed one before any SQL runs (a 'tx-1'::uuid cast raises 22P02, which
// the agent only ever sees as the registry's generic failure).
const TX = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACC = (n: number) => `0b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUPPLIER = '0c000000-0000-4000-8000-000000000001';
const CUSTOMER = '0d000000-0000-4000-8000-000000000002';
const INVOICE = '0e000000-0000-4000-8000-000000000001';
const FOREIGN = '0aaaaaaa-0000-4000-8000-0000000000bb';

function payload(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

function line(n: number): Record<string, unknown> {
  return { transaction_id: TX(n), contra_account_id: ACC(1) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
  vi.mocked(createAllocationBatch).mockResolvedValue(BATCH);
  vi.mocked(recordAllocationBatchLines).mockResolvedValue(undefined);
  vi.mocked(allocateTransaction).mockImplementation(
    (async (_c: string, txId: string) => ({
      journalEntryId: `je-for-${txId}`,
      bankTransaction: { id: txId },
    })) as never,
  );
});

describe('reverse_bank_allocation_batch', () => {
  it('is a posting write tool keyed by idempotency', () => {
    expect(reverseBankAllocationBatchTool.name).toBe('reverse_bank_allocation_batch');
    expect(reverseBankAllocationBatchTool.scope).toBe('write:bank-tx');
    expect(reverseBankAllocationBatchTool.write).toBe(true);
    expect(reverseBankAllocationBatchTool.requiresPost).toBe(true);
    expect(reverseBankAllocationBatchTool.inputSchema.required).toContain('batch_id');
    expect(reverseBankAllocationBatchTool.inputSchema.required).toContain('idempotency_key');
  });

  it('reverses every transaction in the batch and clears the batch stamp', async () => {
    vi.mocked(getAllocationBatchLines).mockResolvedValue([
      { transactionId: TX(1), journalEntryId: 'je-1', currentJournalEntryId: 'je-1' },
      { transactionId: TX(2), journalEntryId: 'je-2', currentJournalEntryId: 'je-2' },
    ]);
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);
    vi.mocked(clearAllocationBatch).mockResolvedValue(undefined);

    const res = await reverseBankAllocationBatchTool.handler(
      { batch_id: BATCH, idempotency_key: 'k1' }, ctx,
    );

    expect(getAllocationBatchLines).toHaveBeenCalledWith('company-1', BATCH);
    expect(reverseReconciledTransaction).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(reverseReconciledTransaction).mock.calls) {
      expect(call[0]).toBe('company-1');
      expect(call[2]).toBe('user-1');
      expect(call[3]).toEqual({ postingAgent: 'mcp:reverse_bank_allocation_batch:v1' });
    }
    expect(clearAllocationBatch).toHaveBeenCalledWith('company-1', BATCH, [TX(1), TX(2)]);
    const body = payload(res as never);
    expect(body.batch_id).toBe(BATCH);
    expect(body.reversed).toBe(2);
    expect(body.transaction_ids).toEqual([TX(1), TX(2)]);
    expect(body.skipped).toEqual([]);
  });

  // The batch stamp says a row was PART of this batch; it does not say the
  // journal now on the row is the one the batch posted. Reversing whatever
  // happens to be there would unwind a posting this batch never made.
  it('leaves a line that was re-allocated to a different journal alone, and says so', async () => {
    vi.mocked(getAllocationBatchLines).mockResolvedValue([
      { transactionId: TX(1), journalEntryId: 'je-1', currentJournalEntryId: 'je-1' },
      { transactionId: TX(2), journalEntryId: 'je-2', currentJournalEntryId: 'je-SOMETHING-ELSE' },
    ]);
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);

    const res = await reverseBankAllocationBatchTool.handler(
      { batch_id: BATCH, idempotency_key: 'k1' }, ctx,
    );

    expect(reverseReconciledTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reverseReconciledTransaction).mock.calls[0]![1]).toBe(TX(1));
    // and the stamp is cleared only on what was actually reversed
    expect(clearAllocationBatch).toHaveBeenCalledWith('company-1', BATCH, [TX(1)]);
    const body = payload(res as never);
    expect(body.reversed).toBe(1);
    expect(body.skipped).toEqual([
      { transaction_id: TX(2), reason: 'allocated to a different journal since this batch posted' },
    ]);
  });

  it('skips a line that was already reversed on its own', async () => {
    vi.mocked(getAllocationBatchLines).mockResolvedValue([
      { transactionId: TX(1), journalEntryId: 'je-1', currentJournalEntryId: null },
    ]);

    const res = await reverseBankAllocationBatchTool.handler(
      { batch_id: BATCH, idempotency_key: 'k1' }, ctx,
    );

    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
    expect(clearAllocationBatch).not.toHaveBeenCalled();
    const body = payload(res as never);
    expect(body.reversed).toBe(0);
    expect(body.skipped).toEqual([
      { transaction_id: TX(1), reason: 'already reversed — no journal on this transaction' },
    ]);
  });

  it("returns the generic NOT_FOUND for another tenant's batch — never an existence oracle", async () => {
    vi.mocked(getAllocationBatchLines).mockResolvedValue(null);
    const res = await reverseBankAllocationBatchTool.handler(
      { batch_id: FOREIGN, idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('RETHROWS a mid-batch reversal failure so nothing is half-reversed', async () => {
    vi.mocked(getAllocationBatchLines).mockResolvedValue([
      { transactionId: TX(1), journalEntryId: 'je-1', currentJournalEntryId: 'je-1' },
      { transactionId: TX(2), journalEntryId: 'je-2', currentJournalEntryId: 'je-2' },
      { transactionId: TX(3), journalEntryId: 'je-3', currentJournalEntryId: 'je-3' },
    ]);
    vi.mocked(reverseReconciledTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new Error('Can only reverse allocated, matched, or reconciled transactions');
    }) as never);

    await expect(
      reverseBankAllocationBatchTool.handler({ batch_id: BATCH, idempotency_key: 'k1' }, ctx),
    ).rejects.toThrow(/Can only reverse/);
    expect(clearAllocationBatch).not.toHaveBeenCalled();
  });

  it('refuses a missing batch_id before touching the ledger', async () => {
    const res = await reverseBankAllocationBatchTool.handler({ idempotency_key: 'k1' }, ctx);
    expect(res.isError).toBe(true);
    expect(getAllocationBatchLines).not.toHaveBeenCalled();
  });

  it('refuses a malformed batch_id before it reaches a ::uuid cast', async () => {
    const res = await reverseBankAllocationBatchTool.handler(
      { batch_id: 'batch-1', idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('invalid batch_id');
    expect(getAllocationBatchLines).not.toHaveBeenCalled();
  });
});
