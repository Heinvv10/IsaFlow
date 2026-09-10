/**
 * PRD-11 §4 — an already-allocated line is SKIPPED, not fatal.
 *
 * The production blocker this file pins: a 124-line pilot batch containing one
 * transaction that had already been allocated came back as
 * "The operation failed. Please try again or contact support." with no line
 * index, and had to be bisected by hand. Two separate faults —
 *
 *   1. nothing looked at the CURRENT state of the resolved rows before posting,
 *      so `dry_run` reported an allocated row as a normal postable line and the
 *      live call only discovered it from inside `allocateTransaction`;
 *   2. anything the handler threw reached the registry's catch, which answers
 *      GENERIC_FAILURE — a per-line cause rendered as an unlocatable batch
 *      failure.
 *
 * Both are asserted here: the pre-check partitions the batch (skipped lines are
 * counted and reported, never re-posted), and a genuinely fatal line throws a
 * typed `BulkAllocationLineError` the registry renders WITH its index.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// The allocation VAT guard reads the contra accounts before posting. This file
// is about skip/race/batch semantics, not VAT, so the guard is stubbed to a
// pass-through — its own behaviour is covered by allocationLineVatGuard and
// allocationVatGuardBatch. Without these three the batch prefetch reaches a
// real pg pool with the fixture's company id.
vi.mock('@/modules/accounting/services/gl/ruleVatResolution', () => ({
  resolveRuleVatCode: vi.fn(async (input: { requestedVatCode: string }) => ({
    vatCode: input.requestedVatCode, denied: false, nonSupplyCoerced: false,
  })),
}));
vi.mock('@/modules/accounting/services/gl/inputVatDenial', () => ({
  fetchVatDenialFlags: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/gl/nonSupplyVatGuard', () => ({
  fetchAccountNames: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/gl/bankContraVat', () => ({
  fetchBankContraFlags: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/lib/mcp/tools/bankPreviewApproval', () => ({
  partitionBankApprovalBound: vi.fn(async (_companyId: string, lines: Array<{ index: number; txId: string }>) => ({ postable: lines, skipped: [] })),
  bankAllocationApprovalRequired: vi.fn(async () => false),
  BANK_APPROVAL_REQUIRED_REASON: 'approval required',
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
  findBankTransactionAllocationStates: vi.fn(),
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

import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  findBankTransactionAllocationStates,
  type BankTransactionAllocationState,
} from '@/modules/accounting/services/bank/bankTransactionLookupService';
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
} from '@/lib/mcp/tools/writeBankBulkAllocate';
import { reverseBankAllocationBatchTool } from '@/lib/mcp/tools/writeBankReverseBatch';
import { BulkAllocationLineError } from '@/lib/mcp/bulkAllocationLineError';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const BATCH = '0f000000-0000-4000-8000-000000000001';
const TX = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACC = (n: number) => `0b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JL = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function payload(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

function line(n: number): Record<string, unknown> {
  return { transaction_id: TX(n), contra_account_id: ACC(1) };
}

/**
 * The row shape the pre-check actually reads.
 *
 * `matchedJournalLineId` is POPULATED on every allocated row — the #261
 * post-mortem trap was a fixture that set only `status`, which let a
 * partition keyed on the journal pass while the real rows failed.
 */
function state(
  n: number,
  status: string,
  journalLine: string | null,
): BankTransactionAllocationState {
  return { id: TX(n), status, matchedJournalLineId: journalLine };
}

function statesReturn(...rows: BankTransactionAllocationState[]): void {
  vi.mocked(findBankTransactionAllocationStates).mockResolvedValue(
    new Map(rows.map((r) => [r.id, r])),
  );
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
  statesReturn(
    state(1, 'imported', null),
    state(2, 'allocated', JL(2)),
    state(3, 'imported', null),
  );
});

describe('bulk_allocate_bank_transactions — already-allocated lines are skipped', () => {
  it('reads every resolved id in ONE company-scoped query', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );
    expect(findBankTransactionAllocationStates).toHaveBeenCalledTimes(1);
    const [company, ids] = vi.mocked(findBankTransactionAllocationStates).mock.calls[0]!;
    expect(company).toBe('company-1');
    expect([...(ids as readonly string[])]).toEqual([TX(1), TX(2), TX(3)]);
  });

  it('dry_run reports the allocated line as skipped and writes nothing', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], dry_run: true, idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.dry_run).toBe(true);
    expect(body.would_post).toBe(2);
    expect(body.lines).toEqual([
      expect.objectContaining({ transaction_id: TX(1) }),
      expect.objectContaining({ transaction_id: TX(3) }),
    ]);
    expect(body.skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'already allocated' },
    ]);

    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(createAllocationBatch).not.toHaveBeenCalled();
    expect(recordAllocationBatchLines).not.toHaveBeenCalled();
  });

  it('posts only the postable lines and reports the skip', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.batch_id).toBe(BATCH);
    expect(body.posted).toBe(2);
    expect(body.skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'already allocated' },
    ]);

    // The allocated row is never handed to the service — a re-post is exactly
    // what the pre-check exists to prevent.
    expect(allocateTransaction).toHaveBeenCalledTimes(2);
    const posted = vi.mocked(allocateTransaction).mock.calls.map((c) => c[1]);
    expect(posted).toEqual([TX(1), TX(3)]);
  });

  it('records the batch (line_count and batch lines) for the POSTED lines only', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );
    const [, , input] = vi.mocked(createAllocationBatch).mock.calls[0]!;
    expect(input.lineCount).toBe(2);

    const [, , recorded] = vi.mocked(recordAllocationBatchLines).mock.calls[0]!;
    expect(recorded.map((l) => l.transactionId)).toEqual([TX(1), TX(3)]);
  });

  it('names the reason for a row that is not allocated but not importable either', async () => {
    statesReturn(state(1, 'imported', null), state(2, 'excluded', null), state(3, 'pending', null));
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], dry_run: true, idempotency_key: 'k1' }, ctx,
    );
    expect(payload(res as never).skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'excluded' },
      { index: 2, transaction_id: TX(3), reason: 'not importable: pending' },
    ]);
  });

  it('reports a row that is BOTH excluded and carrying a journal as both', async () => {
    // A contradiction a human has to see: the row is in the ledger and marked
    // as kept out of it. Either fact alone hides the other.
    statesReturn(state(1, 'imported', null), state(2, 'excluded', JL(2)));
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2)], dry_run: true, idempotency_key: 'k1' }, ctx,
    );
    expect(payload(res as never).skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'already allocated (excluded)' },
    ]);
  });

  it('SKIPS a resolved id that is not in this company at all', async () => {
    // The pre-check is the first thing that can see a transaction_id naming a
    // row this tenant does not have. Reported as the shared NOT_FOUND — the
    // index says WHICH line, the text never says whether the row exists
    // elsewhere.
    //
    // It used to refuse the whole batch. It no longer does: one stale id in a
    // statement-sized list is a fact about that row, not about the request, and
    // failing 499 good lines over it left the agent bisecting by hand. The
    // all-lines-skipped case below is what keeps a wholly wrong list loud.
    // Full coverage of the unresolved cases: bulkAllocateSkipUnresolved.test.ts.
    statesReturn(state(1, 'imported', null), state(3, 'imported', null));
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.posted).toBe(2);
    expect(body.skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'Not found' },
    ]);
    expect(vi.mocked(allocateTransaction).mock.calls.map((c) => c[1]))
      .toEqual([TX(1), TX(3)]);
  });
});

describe('bulk_allocate_bank_transactions — a batch with nothing left to post', () => {
  it('refuses BEFORE opening a batch, listing what it skipped', async () => {
    statesReturn(
      state(1, 'allocated', JL(1)),
      state(2, 'allocated', JL(2)),
      state(3, 'reconciled', JL(3)),
    );
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('nothing to post: all 3 lines skipped');
    expect(res.content[0]!.text).toContain(TX(2));
    // An empty batch would hand the agent an id that reverses nothing.
    expect(createAllocationBatch).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('dry_run reports the same batch without refusing it', async () => {
    statesReturn(state(1, 'allocated', JL(1)));
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1)], dry_run: true, idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.would_post).toBe(0);
    expect(body.skipped).toHaveLength(1);
  });
});

describe('bulk_allocate_bank_transactions — a line that races the pre-check', () => {
  it('counts a row allocated between the pre-check and the post as skipped, and continues', async () => {
    // The pre-check saw TX(2) as importable; allocateTransaction's own guard
    // fires after its FOR UPDATE because a concurrent request allocated it in
    // between. The row lock plus that guard make this safe to treat exactly
    // like the pre-check skip — nothing was posted for the line.
    statesReturn(state(1, 'imported', null), state(2, 'imported', null), state(3, 'imported', null));
    vi.mocked(allocateTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new Error('Transaction already allocated — cannot allocate');
      return { journalEntryId: `je-for-${txId}`, bankTransaction: { id: txId } };
    }) as never);

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.posted).toBe(2);
    expect(body.skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'already allocated' },
    ]);
    // Line 3 is still attempted — a race on one row must not abandon the batch.
    expect(allocateTransaction).toHaveBeenCalledTimes(3);
  });

  it('reports the STATUS the service refused on, not a blanket "already allocated"', async () => {
    // The refusal message carries the real status. Reporting every race as
    // "already allocated" would tell an agent its EXCLUDED transaction had been
    // booked — the same mapping the pre-check uses has to apply here.
    statesReturn(state(1, 'imported', null), state(2, 'imported', null));
    vi.mocked(allocateTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new Error('Transaction already excluded — cannot allocate');
      return { journalEntryId: `je-for-${txId}`, bankTransaction: { id: txId } };
    }) as never);

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2)], idempotency_key: 'k1' }, ctx,
    );
    expect(payload(res as never).skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'excluded' },
    ]);
  });

  it('reports a raced status that is neither allocated nor excluded verbatim', async () => {
    statesReturn(state(1, 'imported', null), state(2, 'imported', null));
    vi.mocked(allocateTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new Error('Transaction already pending — cannot allocate');
      return { journalEntryId: `je-for-${txId}`, bankTransaction: { id: txId } };
    }) as never);

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2)], idempotency_key: 'k1' }, ctx,
    );
    expect(payload(res as never).skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'not importable: pending' },
    ]);
  });
});

describe('bulk_allocate_bank_transactions — a genuinely fatal line', () => {
  it('throws BulkAllocationLineError carrying the index and the transaction', async () => {
    vi.mocked(allocateTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === TX(3)) throw new Error('Period 2026-07 is closed');
      return { journalEntryId: `je-for-${txId}`, bankTransaction: { id: txId } };
    }) as never);
    statesReturn(state(1, 'imported', null), state(2, 'imported', null), state(3, 'imported', null));

    const call = bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );

    await expect(call).rejects.toThrow(BulkAllocationLineError);
    // The whole point: the message the registry renders must locate the line.
    await call.catch((err: unknown) => {
      const e = err as BulkAllocationLineError;
      expect(e.index).toBe(2);
      expect(e.transactionId).toBe(TX(3));
      expect(e.detail).toContain('Period 2026-07 is closed');
    });
    // Nothing is reported as posted: only a THROW unwinds the registry savepoint.
    expect(recordAllocationBatchLines).not.toHaveBeenCalled();
  });

  it('still rethrows a failure that is not per-line at all', async () => {
    vi.mocked(recordAllocationBatchLines).mockRejectedValue(new Error('stamp failed'));
    await expect(
      bulkAllocateBankTransactionsTool.handler({ allocations: [line(1)], idempotency_key: 'k1' }, ctx),
    ).rejects.toThrow(/stamp failed/);
  });
});

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

describe('bulk_allocate_bank_transactions — a row locked by another request', () => {
  it('skips it as retryable and keeps the batch going', async () => {
    // The lock is taken BEFORE anything is posted, so a timeout is write-free —
    // the same class as the race. Failing 499 good lines because one row was
    // briefly busy is the opposite of what a bulk tool is for.
    statesReturn(state(1, 'imported', null), state(2, 'imported', null), state(3, 'imported', null));
    vi.mocked(allocateTransaction).mockImplementation((async (_c: string, txId: string) => {
      if (txId === TX(2)) {
        throw Object.assign(
          new Error(`Bank transaction ${TX(2)} is being allocated by another request — retry in a moment.`),
          { code: 'BANK_TX_LOCK_TIMEOUT' },
        );
      }
      return { journalEntryId: `je-for-${txId}`, bankTransaction: { id: txId } };
    }) as never);

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(3)], idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.posted).toBe(2);
    expect(body.skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'locked by another request — retry' },
    ]);
    expect(allocateTransaction).toHaveBeenCalledTimes(3);
  });
});

describe('bulk_allocate_bank_transactions — what a fatal line is allowed to say', () => {
  /** The message the registry would render for this failure. */
  async function detailFor(err: unknown): Promise<string> {
    statesReturn(state(1, 'imported', null));
    vi.mocked(allocateTransaction).mockRejectedValue(err);
    const call = bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1)], idempotency_key: 'k1' }, ctx,
    );
    return call.then(
      () => { throw new Error('expected the line to fail'); },
      (e: unknown) => (e as BulkAllocationLineError).detail,
    );
  }

  it('reduces a driver error to its SQLSTATE — no table, column or constraint names', async () => {
    // BulkAllocationLineError is the ONE exception to GENERIC_FAILURE, so it is
    // also the one place the "no SQL in a tool result" invariant could be
    // smuggled back out. A pg message names the schema that failed.
    const detail = await detailFor(Object.assign(
      new Error('insert or update on table "gl_journal_lines" violates foreign key '
        + 'constraint "gl_journal_lines_journal_entry_id_fkey"'),
      { code: '23503' },
    ));
    expect(detail).toBe('database error 23503');
    expect(detail).not.toContain('gl_journal_lines');
    expect(detail).not.toContain('constraint');
  });

  it('catches a database message that arrives with no code at all', async () => {
    const detail = await detailFor(new Error('relation "bank_transactions_old" does not exist'));
    expect(detail).toBe('database error');
    expect(detail).not.toContain('bank_transactions_old');
  });

  it('passes a service message through — it was written for this reader', async () => {
    const detail = await detailFor(new Error('Fiscal period 2026-07 is closed'));
    expect(detail).toBe('Fiscal period 2026-07 is closed');
  });

  it('caps a runaway message rather than pasting it into the reply', async () => {
    const detail = await detailFor(new Error('x'.repeat(5000)));
    expect(detail.length).toBeLessThanOrEqual(201);
    expect(detail.endsWith('…')).toBe(true);
  });
});
