/**
 * PRD-11 §4 — the writing half: posting, ALL-OR-NOTHING rollback, and batch
 * reversal. (Pre-write validation is in writeBankBulkAllocate.test.ts.)
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
  stampAllocationBatch: vi.fn(),
  getAllocationBatchTransactionIds: vi.fn(),
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
  stampAllocationBatch,
  getAllocationBatchTransactionIds,
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
const BATCH = 'batch-1';

function payload(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

function line(n: number): Record<string, unknown> {
  return { transaction_id: `tx-${n}`, contra_account_id: 'acc-1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
  vi.mocked(createAllocationBatch).mockResolvedValue(BATCH);
  vi.mocked(stampAllocationBatch).mockResolvedValue(undefined);
  vi.mocked(allocateTransaction).mockImplementation(
    (async (_c: string, txId: string) => ({
      journalEntryId: `je-for-${txId}`,
      bankTransaction: { id: txId },
    })) as never,
  );
});

describe('bulk_allocate_bank_transactions — posting', () => {
  it('posts every line through allocateTransaction with the bulk posting agent', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );
    expect(allocateTransaction).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(allocateTransaction).mock.calls) {
      expect(call[0]).toBe('company-1');
      expect(call[3]).toBe('user-1');
      expect(call[12]).toEqual({ postingAgent: 'mcp:bulk_allocate_bank_transactions:v1' });
    }
    const body = payload(res as never);
    expect(body.batch_id).toBe(BATCH);
    expect(body.posted).toBe(3);
    expect(body.journal_entry_ids).toEqual(['je-for-tx-1', 'je-for-tx-2', 'je-for-tx-3']);
    expect(body.lines).toEqual([
      { transaction_id: 'tx-1', journal_entry_id: 'je-for-tx-1' },
      { transaction_id: 'tx-2', journal_entry_id: 'je-for-tx-2' },
      { transaction_id: 'tx-3', journal_entry_id: 'je-for-tx-3' },
    ]);
  });

  it('stamps the batch id onto every allocated transaction so the batch can be reversed', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2)], idempotency_key: 'k1' }, ctx,
    );
    expect(stampAllocationBatch).toHaveBeenCalledWith('company-1', BATCH, ['tx-1', 'tx-2']);
  });

  it('passes alloc_type, entity, invoice, vat and description straight through', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{
          transaction_id: 'tx-1',
          alloc_type: 'supplier',
          entity_id: 'sup-1',
          invoice_id: 'inv-1',
          vat_code: 'standard',
          description: 'Rent',
        }],
        idempotency_key: 'k1',
      },
      ctx,
    );
    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect(call[2]).toBeNull();          // contra ignored for supplier
    expect(call[4]).toBe('Rent');
    expect(call[5]).toBe('supplier');
    expect(call[6]).toBe('sup-1');
    expect(call[7]).toBe('standard');
    expect(call[11]).toBe('inv-1');
  });
});

describe('bulk_allocate_bank_transactions — all or nothing', () => {
  it('RETHROWS a mid-batch failure so the registry savepoint rolls the whole batch back', async () => {
    vi.mocked(allocateTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === 'tx-3') throw new Error('Transaction already allocated — cannot allocate');
      return { journalEntryId: `je-for-${txId}`, bankTransaction: { id: txId } };
    }) as never);

    await expect(
      bulkAllocateBankTransactionsTool.handler(
        { allocations: [line(1), line(2), line(3), line(4)], idempotency_key: 'k1' }, ctx,
      ),
    ).rejects.toThrow(/already allocated/);

    // Line 4 is never attempted, and nothing is reported as posted: the two
    // journals lines 1-2 created only survive if the throw is swallowed.
    expect(allocateTransaction).toHaveBeenCalledTimes(3);
  });

  it('does not swallow a pg-level failure into a tidy toolError', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );
    await expect(
      bulkAllocateBankTransactionsTool.handler({ allocations: [line(1)], idempotency_key: 'k1' }, ctx),
    ).rejects.toThrow(/deadlock detected/);
  });

  it('rethrows a failure to stamp the batch — an unreversible batch must not commit', async () => {
    vi.mocked(stampAllocationBatch).mockRejectedValue(new Error('stamp failed'));
    await expect(
      bulkAllocateBankTransactionsTool.handler({ allocations: [line(1)], idempotency_key: 'k1' }, ctx),
    ).rejects.toThrow(/stamp failed/);
  });
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
    vi.mocked(getAllocationBatchTransactionIds).mockResolvedValue(['tx-1', 'tx-2']);
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);
    vi.mocked(clearAllocationBatch).mockResolvedValue(undefined);

    const res = await reverseBankAllocationBatchTool.handler(
      { batch_id: BATCH, idempotency_key: 'k1' }, ctx,
    );

    expect(getAllocationBatchTransactionIds).toHaveBeenCalledWith('company-1', BATCH);
    expect(reverseReconciledTransaction).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(reverseReconciledTransaction).mock.calls) {
      expect(call[0]).toBe('company-1');
      expect(call[2]).toBe('user-1');
      expect(call[3]).toEqual({ postingAgent: 'mcp:reverse_bank_allocation_batch:v1' });
    }
    expect(clearAllocationBatch).toHaveBeenCalledWith('company-1', BATCH, ['tx-1', 'tx-2']);
    const body = payload(res as never);
    expect(body.batch_id).toBe(BATCH);
    expect(body.reversed).toBe(2);
    expect(body.transaction_ids).toEqual(['tx-1', 'tx-2']);
  });

  it("returns the generic NOT_FOUND for another tenant's batch — never an existence oracle", async () => {
    vi.mocked(getAllocationBatchTransactionIds).mockResolvedValue(null);
    const res = await reverseBankAllocationBatchTool.handler(
      { batch_id: 'company-B-batch', idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('RETHROWS a mid-batch reversal failure so nothing is half-reversed', async () => {
    vi.mocked(getAllocationBatchTransactionIds).mockResolvedValue(['tx-1', 'tx-2', 'tx-3']);
    vi.mocked(reverseReconciledTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === 'tx-2') throw new Error('Can only reverse allocated, matched, or reconciled transactions');
    }) as never);

    await expect(
      reverseBankAllocationBatchTool.handler({ batch_id: BATCH, idempotency_key: 'k1' }, ctx),
    ).rejects.toThrow(/Can only reverse/);
    expect(clearAllocationBatch).not.toHaveBeenCalled();
  });

  it('refuses a missing batch_id before touching the ledger', async () => {
    const res = await reverseBankAllocationBatchTool.handler({ idempotency_key: 'k1' }, ctx);
    expect(res.isError).toBe(true);
    expect(getAllocationBatchTransactionIds).not.toHaveBeenCalled();
  });
});
