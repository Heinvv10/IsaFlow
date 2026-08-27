/**
 * PRD-11 §4 — bulk_allocate_bank_transactions / reverse_bank_allocation_batch.
 *
 * The control under test is ALL-OR-NOTHING. registry.ts wraps every
 * `write: true` tool in ONE `withSavepoint`, and that savepoint rolls back only
 * when the handler THROWS: a `catch → toolError` returns normally, the
 * savepoint RELEASES, and because the MCP transport answers HTTP 200 for every
 * tool result (isError included) bearerPipeline COMMITs whatever the first two
 * lines already posted. A 500-line batch that half-posts is exactly the failure
 * this tool exists to avoid, so the mid-batch rethrow is asserted directly.
 *
 * Everything that can be refused BEFORE the first allocateTransaction call —
 * shape, size, duplicates, tenant ownership — must still come back as a
 * precise toolError: there is nothing to roll back, and a generic failure would
 * leave the agent guessing which of 500 lines was wrong.
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
import { findBankTransactionsByReference } from '@/modules/accounting/services/bank/bankTransactionLookupService';
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

describe('bulk_allocate_bank_transactions — surface', () => {
  it('posts journals, so it demands write:post and an idempotency key', () => {
    expect(bulkAllocateBankTransactionsTool.name).toBe('bulk_allocate_bank_transactions');
    expect(bulkAllocateBankTransactionsTool.scope).toBe('write:bank-tx');
    expect(bulkAllocateBankTransactionsTool.write).toBe(true);
    expect(bulkAllocateBankTransactionsTool.requiresPost).toBe(true);
    expect(bulkAllocateBankTransactionsTool.inputSchema.required).toContain('idempotency_key');
    expect(bulkAllocateBankTransactionsTool.inputSchema.required).toContain('allocations');
  });
});

describe('bulk_allocate_bank_transactions — pre-write refusals', () => {
  it('refuses an empty batch without opening one', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [], idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(createAllocationBatch).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses more than 500 lines before any ownership query runs', async () => {
    const allocations = Array.from({ length: 501 }, (_, i) => line(i));
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations, idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/500/);
    expect(accountsBelongToCompany).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses a duplicated transaction id — the second line would post against an already-allocated row', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(1)], idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/tx-1/);
    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(createAllocationBatch).not.toHaveBeenCalled();
  });

  it('refuses a duplicate that only appears once the bank_reference is resolved', async () => {
    vi.mocked(findBankTransactionsByReference).mockResolvedValue([
      { id: 'tx-1', transactionDate: '2026-08-01', amount: -100, description: null },
    ]);
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), { bank_reference: 'REF1', contra_account_id: 'acc-1' }], idempotency_key: 'k1' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses a line naming both a transaction_id and a bank_reference', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{ transaction_id: 'tx-1', bank_reference: 'REF1', contra_account_id: 'acc-1' }],
        idempotency_key: 'k1',
      },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('names the offending line index so the agent can fix 1 of 500', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), { transaction_id: 'tx-2', alloc_type: 'transfer' }], idempotency_key: 'k1' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/allocations\[1\]/);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });
});

describe('bulk_allocate_bank_transactions — tenant ownership', () => {
  it('checks every contra account in ONE query, not one per line', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [
          { transaction_id: 'tx-1', contra_account_id: 'acc-1' },
          { transaction_id: 'tx-2', contra_account_id: 'acc-2' },
          { transaction_id: 'tx-3', contra_account_id: 'acc-1' },
        ],
        idempotency_key: 'k1',
      },
      ctx,
    );
    expect(accountsBelongToCompany).toHaveBeenCalledTimes(1);
    const [company, ids] = vi.mocked(accountsBelongToCompany).mock.calls[0]!;
    expect(company).toBe('company-1');
    expect([...(ids as string[])].sort()).toEqual(['acc-1', 'acc-2']);
  });

  it('refuses a foreign contra account with the generic NOT_FOUND text and posts nothing', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), { transaction_id: 'tx-2', contra_account_id: 'company-B-account' }], idempotency_key: 'k1' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(createAllocationBatch).not.toHaveBeenCalled();
  });

  it('refuses a foreign supplier entity and posts nothing', async () => {
    vi.mocked(suppliersBelongToCompany).mockResolvedValue(false);
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{ transaction_id: 'tx-1', alloc_type: 'supplier', entity_id: 'company-B-supplier' }],
        idempotency_key: 'k1',
      },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses a foreign customer entity and posts nothing', async () => {
    vi.mocked(customersBelongToCompany).mockResolvedValue(false);
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{ transaction_id: 'tx-1', alloc_type: 'customer', entity_id: 'company-B-customer' }],
        idempotency_key: 'k1',
      },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('reads the tenant from ctx only — a company_id in the args is ignored', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1)], company_id: 'company-B', idempotency_key: 'k1' }, ctx,
    );
    expect(vi.mocked(allocateTransaction).mock.calls[0]![0]).toBe('company-1');
    expect(vi.mocked(createAllocationBatch).mock.calls[0]![0]).toBe('company-1');
  });
});

describe('bulk_allocate_bank_transactions — dry run', () => {
  it('writes nothing at all: no batch, no allocation', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2)], dry_run: true, idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(createAllocationBatch).not.toHaveBeenCalled();
    expect(stampAllocationBatch).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('returns the resolved lines it would post, with no batch id', async () => {
    vi.mocked(findBankTransactionsByReference).mockResolvedValue([
      { id: 'tx-9', transactionDate: '2026-08-01', amount: -100, description: null },
    ]);
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [line(1), { bank_reference: 'REF9', contra_account_id: 'acc-2' }],
        dry_run: true,
        idempotency_key: 'k1',
      },
      ctx,
    );
    const body = payload(res as never);
    expect(body.dry_run).toBe(true);
    expect(body.batch_id).toBeNull();
    expect(body.posted).toBe(0);
    expect(body.lines).toEqual([
      expect.objectContaining({ transaction_id: 'tx-1', contra_account_id: 'acc-1', alloc_type: 'account' }),
      expect.objectContaining({ transaction_id: 'tx-9', contra_account_id: 'acc-2', alloc_type: 'account' }),
    ]);
  });

  it('still refuses a dry run whose ids belong to another tenant', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1)], dry_run: true, idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
  });
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
