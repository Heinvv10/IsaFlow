/**
 * `reversal_date` is offered, threaded through, and DESCRIBED.
 *
 * The gap this closes: the reversal date existed only as an internal local
 * variable. No surface took it as a parameter, and no tool description said
 * which date a contra would carry — so an agent correcting a closed month had
 * no way to find out except by posting one and looking.
 *
 * The date's RULES (real calendar day, not before the entry it reverses) live in
 * reverseJournalEntry and are pinned by journalEntryReversalDate.test.ts. These
 * tests pin the wiring instead, which is the part that silently rots: a
 * parameter declared in the schema but dropped before the service call looks
 * exactly like a working feature until someone checks the posted date.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  splitAllocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
  findBankTransactionAllocationStates: vi.fn(),
  getBankTransactionStatus: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationBatchService', () => ({
  createAllocationBatch: vi.fn(),
  recordAllocationBatchLines: vi.fn(),
  getAllocationBatchLines: vi.fn(),
  clearAllocationBatch: vi.fn(),
}));

import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getBankTransactionStatus } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import {
  getAllocationBatchLines,
  clearAllocationBatch,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';
import { reverseBankAllocationBatchTool } from '@/lib/mcp/tools/writeBankReverseBatch';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const TX = '0a000000-0000-4000-8000-000000000001';
const BATCH = '0f000000-0000-4000-8000-000000000001';
const JE = '0c000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBankTransactionStatus).mockResolvedValue('allocated' as never);
  vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined as never);
  vi.mocked(getAllocationBatchLines).mockResolvedValue([
    { transactionId: TX, journalEntryId: JE, currentJournalEntryId: JE, transactionExists: true },
  ] as never);
  vi.mocked(clearAllocationBatch).mockResolvedValue(undefined as never);
});

/** The opts object handed to the service on the Nth call. */
function optsOfCall(n = 0): Record<string, unknown> {
  return vi.mocked(reverseReconciledTransaction).mock.calls[n]![3] as Record<string, unknown>;
}

describe('reverse_bank_allocation — reversal_date', () => {
  it('declares the parameter, so an agent can discover it', () => {
    const props = reverseBankAllocationTool.inputSchema.properties as Record<string, unknown>;
    expect(props.reversal_date).toBeDefined();
  });

  it('says in its description which date the reversal carries by default', () => {
    // The half that is easy to forget: offering the override without stating
    // the default leaves the original question unanswered.
    const d = reverseBankAllocationTool.description;
    expect(d).toMatch(/reversal_date/);
    expect(d).toMatch(/original/i);
    expect(d).toMatch(/closed/i);
  });

  it('passes the caller date through to the service', async () => {
    await reverseBankAllocationTool.handler(
      { transaction_id: TX, reversal_date: '2026-07-15', idempotency_key: 'k1' }, ctx,
    );
    expect(optsOfCall().reversalDate).toBe('2026-07-15');
  });

  it('omits the key entirely when no date was given, preserving the default', async () => {
    // Not `reversalDate: undefined` — the service branches on `=== undefined`,
    // so either shape works today, but an absent key cannot be mistaken for a
    // caller who asked for "no date".
    await reverseBankAllocationTool.handler(
      { transaction_id: TX, idempotency_key: 'k1' }, ctx,
    );
    expect(optsOfCall()).not.toHaveProperty('reversalDate');
  });

  it('still stamps the posting agent alongside the date', async () => {
    // The attribution stamp is what keeps an agent's own correction inside
    // list_agent_postings; adding a second opt must not displace it.
    await reverseBankAllocationTool.handler(
      { transaction_id: TX, reversal_date: '2026-07-15', idempotency_key: 'k1' }, ctx,
    );
    expect(optsOfCall().postingAgent).toBeTruthy();
  });
});

describe('reverse_bank_allocation_batch — reversal_date', () => {
  it('declares the parameter and describes the default', () => {
    const props = reverseBankAllocationBatchTool.inputSchema.properties as Record<string, unknown>;
    expect(props.reversal_date).toBeDefined();
    const d = reverseBankAllocationBatchTool.description;
    expect(d).toMatch(/reversal_date/);
    expect(d).toMatch(/original/i);
  });

  it('applies the caller date to every line in the batch', async () => {
    const TX2 = '0a000000-0000-4000-8000-000000000002';
    vi.mocked(getAllocationBatchLines).mockResolvedValue([
      { transactionId: TX, journalEntryId: JE, currentJournalEntryId: JE, transactionExists: true },
      { transactionId: TX2, journalEntryId: JE, currentJournalEntryId: JE, transactionExists: true },
    ] as never);

    await reverseBankAllocationBatchTool.handler(
      { batch_id: BATCH, reversal_date: '2026-07-15', idempotency_key: 'k1' }, ctx,
    );

    expect(vi.mocked(reverseReconciledTransaction)).toHaveBeenCalledTimes(2);
    expect(optsOfCall(0).reversalDate).toBe('2026-07-15');
    expect(optsOfCall(1).reversalDate).toBe('2026-07-15');
  });

  it('omits the key when no date was given', async () => {
    await reverseBankAllocationBatchTool.handler(
      { batch_id: BATCH, idempotency_key: 'k1' }, ctx,
    );
    expect(optsOfCall()).not.toHaveProperty('reversalDate');
  });
});
