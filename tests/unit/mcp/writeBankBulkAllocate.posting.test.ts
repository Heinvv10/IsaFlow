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
  // Batched resolution (one query per bulk call) — the plural is what the
  // selector resolver actually calls; default to "nothing matched".
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
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
    expect(body.journal_entry_ids).toEqual([`je-for-${TX(1)}`, `je-for-${TX(2)}`, `je-for-${TX(3)}`]);
    expect(body.lines).toEqual([
      { transaction_id: TX(1), journal_entry_id: `je-for-${TX(1)}` },
      { transaction_id: TX(2), journal_entry_id: `je-for-${TX(2)}` },
      { transaction_id: TX(3), journal_entry_id: `je-for-${TX(3)}` },
    ]);
  });

  it('posts in transaction-id order however the agent ordered the batch', async () => {
    // Every line takes a row lock that is held to the end of the request, so
    // two overlapping batches that walk their rows in opposite orders deadlock
    // (40P01). Sorting gives every batch the same lock order, which turns the
    // deadlock into one batch simply waiting for the other.
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(3), line(1), line(2)], idempotency_key: 'k1' }, ctx,
    );

    const order = vi.mocked(allocateTransaction).mock.calls.map((c) => c[1]);
    expect(order).toEqual([TX(1), TX(2), TX(3)]);
    expect(order).toEqual([...order].sort());
  });

  it('records the journal each line posted, so the reverse tool can prove ownership', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2)], idempotency_key: 'k1' }, ctx,
    );
    expect(recordAllocationBatchLines).toHaveBeenCalledWith('company-1', BATCH, [
      { transactionId: TX(1), journalEntryId: `je-for-${TX(1)}` },
      { transactionId: TX(2), journalEntryId: `je-for-${TX(2)}` },
    ]);
  });

  it('passes alloc_type, entity, invoice, vat and description straight through', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{
          transaction_id: TX(1),
          alloc_type: 'supplier',
          entity_id: SUPPLIER,
          invoice_id: INVOICE,
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
    expect(call[6]).toBe(SUPPLIER);
    expect(call[7]).toBe('standard');
    expect(call[11]).toBe(INVOICE);
  });
});

describe('bulk_allocate_bank_transactions — all or nothing', () => {
  it('RETHROWS a mid-batch failure so the registry savepoint rolls the whole batch back', async () => {
    vi.mocked(allocateTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === TX(3)) throw new Error('Transaction already allocated — cannot allocate');
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

  it('rethrows a failure to record the batch lines — an unreversible batch must not commit', async () => {
    vi.mocked(recordAllocationBatchLines).mockRejectedValue(new Error('stamp failed'));
    await expect(
      bulkAllocateBankTransactionsTool.handler({ allocations: [line(1)], idempotency_key: 'k1' }, ctx),
    ).rejects.toThrow(/stamp failed/);
  });
});
