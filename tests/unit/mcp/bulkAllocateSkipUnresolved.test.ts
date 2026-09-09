/**
 * A line whose reference does not resolve is SKIPPED, not fatal.
 *
 * Sibling of bulkAllocateSkipAllocated.test.ts, and the same argument one step
 * earlier in the pipeline. PRD-11 §4 already made an already-allocated row a
 * skip because a batch assembled off a statement routinely names rows the books
 * have moved on from. A reference that resolves to nothing — or to more than
 * one row — is the same kind of fact about ONE line, and it was still failing
 * the whole call: a 500-line batch with a single unrecognised reference posted
 * nothing, and the agent could only find the bad line by bisecting.
 *
 * So `Not found` and `bank_reference is ambiguous` join `already allocated` in
 * `skipped`, carrying the agent's own line index, and the rest of the batch
 * posts.
 *
 * Two properties this file pins that the change must NOT cost:
 *
 *   1. A batch where NOTHING resolves is still a loud refusal, not a silent
 *      `posted: 0`. Skipping is what stops one typo poisoning 499 good lines;
 *      it is not permission for a wholly wrong list to look like housekeeping.
 *   2. Malformed lines and cross-tenant ids stay FATAL. They are faults in what
 *      the caller SENT rather than facts about a row's state, and the ownership
 *      refusal is deliberately batch-level — naming which line held the foreign
 *      id is the existence oracle the shared NOT_FOUND text exists to avoid.
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
  findBankTransactionsByReferences,
  type BankTransactionAllocationState,
  type BankTransactionRefMatch,
} from '@/modules/accounting/services/bank/bankTransactionLookupService';
import {
  createAllocationBatch,
  recordAllocationBatchLines,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const BATCH = '0f000000-0000-4000-8000-000000000001';
const TX = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACC = (n: number) => `0b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JL = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function payload(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

/** A line naming its transaction by UUID. */
function byId(n: number): Record<string, unknown> {
  return { transaction_id: TX(n), contra_account_id: ACC(1) };
}

/** A line naming its transaction by the reference printed on the statement. */
function byRef(ref: string): Record<string, unknown> {
  return { bank_reference: ref, contra_account_id: ACC(1) };
}

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

function match(n: number): BankTransactionRefMatch {
  return {
    id: TX(n),
    transactionDate: '2026-08-01',
    amount: 100 + n,
    matchedColumn: 'reference',
    matchedReference: `REF-${n}`,
  } as BankTransactionRefMatch;
}

/** What `resolveTxSelectors` sees: reference → candidate rows. */
function refsReturn(map: Record<string, BankTransactionRefMatch[]>): void {
  vi.mocked(findBankTransactionsByReferences).mockResolvedValue(
    new Map(Object.entries(map)),
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
  statesReturn(state(1, 'imported', null), state(3, 'imported', null));
  refsReturn({});
});

describe('bulk_allocate_bank_transactions — an unresolved reference is skipped', () => {
  it('skips a reference that matches nothing and posts the rest', async () => {
    // REF-GOOD resolves to tx 3; REF-NONE matches no row at all.
    refsReturn({ 'REF-GOOD': [match(3)] });

    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [byId(1), byRef('REF-NONE'), byRef('REF-GOOD')],
        idempotency_key: 'k1',
      },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.posted).toBe(2);
    expect(body.skipped).toEqual([
      { index: 1, transaction_id: null, reason: 'Not found' },
    ]);
    expect(vi.mocked(allocateTransaction).mock.calls.map((c) => c[1])).toEqual([
      TX(1),
      TX(3),
    ]);
  });

  it('skips an ambiguous reference, naming the candidates in the reason', async () => {
    refsReturn({ 'REF-DUP': [match(2), match(3)] });

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [byId(1), byRef('REF-DUP')], idempotency_key: 'k1' },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.posted).toBe(1);

    const skipped = body.skipped as { index: number; transaction_id: null; reason: string }[];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.index).toBe(1);
    expect(skipped[0]!.transaction_id).toBeNull();
    // The candidate ids stay in the reason: the agent's only route out of an
    // ambiguous reference is to re-issue naming one of them explicitly.
    expect(skipped[0]!.reason).toContain('ambiguous');
    expect(skipped[0]!.reason).toContain(TX(2));
    expect(skipped[0]!.reason).toContain(TX(3));

    // Never guessed at a candidate — posting one of two same-reference rows is
    // the failure the ambiguity refusal exists to prevent.
    expect(vi.mocked(allocateTransaction).mock.calls.map((c) => c[1])).toEqual([TX(1)]);
  });

  it('dry_run reports the same skips as the live call and writes nothing', async () => {
    refsReturn({ 'REF-NONE': [], 'REF-DUP': [match(2), match(3)] });

    const args = {
      allocations: [byId(1), byRef('REF-NONE'), byRef('REF-DUP')],
      idempotency_key: 'k1',
    };
    const dry = payload(
      (await bulkAllocateBankTransactionsTool.handler(
        { ...args, dry_run: true }, ctx,
      )) as never,
    );
    const live = payload(
      (await bulkAllocateBankTransactionsTool.handler(args, ctx)) as never,
    );

    expect(dry.would_post).toBe(1);
    expect(live.posted).toBe(1);
    // Parity is the whole point: a dry run that short-circuits at reference
    // resolution reports a batch the live call will not produce.
    expect(dry.skipped).toEqual(live.skipped);
    expect(dry.skipped).toEqual([
      { index: 1, transaction_id: null, reason: 'Not found' },
      expect.objectContaining({ index: 2, transaction_id: null }),
    ]);
  });

  it('skips a resolved id whose row has vanished from the state read', async () => {
    // tx 2 resolves fine but is absent from findBankTransactionAllocationStates
    // — deleted by undo_bank_import between the two queries, say. Previously
    // this refused the whole batch.
    statesReturn(state(1, 'imported', null));

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [byId(1), byId(2)], idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBeUndefined();
    const body = payload(res as never);
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'Not found' },
    ]);
  });

  it('orders unresolved and already-allocated skips by the agent line index', async () => {
    refsReturn({ 'REF-NONE': [] });
    statesReturn(state(1, 'allocated', JL(1)), state(3, 'imported', null));

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [byId(1), byRef('REF-NONE'), byId(3)], idempotency_key: 'k1' },
      ctx,
    );

    const body = payload(res as never);
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual([
      { index: 0, transaction_id: TX(1), reason: 'already allocated' },
      { index: 1, transaction_id: null, reason: 'Not found' },
    ]);
  });

  it('still REFUSES a batch in which nothing resolves', async () => {
    refsReturn({});

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [byRef('REF-A'), byRef('REF-B')], idempotency_key: 'k1' },
      ctx,
    );

    // A wholly wrong list must not read as a successful no-op.
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('nothing to post');
    expect(res.content[0]!.text).toContain('allocations[0]');
    expect(res.content[0]!.text).toContain('allocations[1]');
    expect(createAllocationBatch).not.toHaveBeenCalled();
  });

  it('keeps a MALFORMED line fatal — that is a fault in what was sent', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [byId(1), { contra_account_id: ACC(1) }], idempotency_key: 'k1' },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('allocations[1]');
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('keeps a CROSS-TENANT contra account fatal and batch-level', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [byId(1), byId(3)], idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
    // Batch-level: naming the line would say which id exists in another tenant.
    expect(res.content[0]!.text).not.toContain('allocations[');
    expect(allocateTransaction).not.toHaveBeenCalled();
  });
});
