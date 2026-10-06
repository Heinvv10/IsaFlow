/**
 * reverse_bank_allocation_batch reverses exactly what bulk_allocate_bank_transactions' batch posted — moved out of
 * bulkAllocateSkipAllocated.test.ts (NUMRACE: that file is over 300 lines and the reversal tool now needs the
 * reversal-year prediction stubbed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The reversal tools' up-front year lock reads journals (NUMRACE; tested against Postgres) — not this file's subject.
vi.mock('@/modules/accounting/services/gl/journalReversalYears', () => ({ predictReversalYears: vi.fn(async () => new Map()) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationBatchService', () => ({
  createAllocationBatch: vi.fn(),
  recordAllocationBatchLines: vi.fn(),
  getAllocationBatchLines: vi.fn(),
  clearAllocationBatch: vi.fn(),
}));

import {
  getAllocationBatchLines,
  clearAllocationBatch,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { reverseBankAllocationBatchTool } from '@/lib/mcp/tools/writeBankReverseBatch';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const BATCH = '0f000000-0000-4000-8000-000000000001';
const TX = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function payload(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('reverse_bank_allocation_batch — reverses exactly what the batch posted', () => {
  it('reverses the two posted lines and leaves the skipped one alone', async () => {
    // The batch recorded only the lines it posted, so the skipped transaction
    // is not in it and cannot be reversed by this batch id.
    vi.mocked(getAllocationBatchLines).mockResolvedValue([
      {
        transactionId: TX(1), journalEntryId: `je-for-${TX(1)}`,
        currentJournalEntryId: `je-for-${TX(1)}`, transactionExists: true,
      },
      {
        transactionId: TX(3), journalEntryId: `je-for-${TX(3)}`,
        currentJournalEntryId: `je-for-${TX(3)}`, transactionExists: true,
      },
    ]);
    vi.mocked(clearAllocationBatch).mockResolvedValue(undefined);

    const res = await reverseBankAllocationBatchTool.handler(
      { batch_id: BATCH, idempotency_key: 'k2' }, ctx,
    );
    const body = payload(res as never);
    expect(body.reversed).toBe(2);
    expect(body.transaction_ids).toEqual([TX(1), TX(3)]);
    expect(body.skipped).toEqual([]);
  });
});
