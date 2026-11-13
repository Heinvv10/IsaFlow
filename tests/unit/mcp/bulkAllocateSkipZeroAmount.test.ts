/**
 * A R0.00 statement line is SKIPPED ('zero_amount'), never posted and never fatal. The end-to-end proof (registry,
 * savepoint, idempotency, dry run) is tests/integration/mcp-bulk-allocate-zero-amount.int.test.ts; this pins the
 * reason's precedence against the other row-state skips, which the integration fixture cannot reach cheaply.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({ findBankTransactionAllocationStates: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankLineJournalGate', () => ({ handKeyedAccountLineSkips: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/bank/contactControlGuard', async () => (await import('../helpers/bankControlGateMocks')).contactControlOpen());
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/lib/mcp/tools/allocationApplyRoute', () => ({
  applyRouteFor: vi.fn(() => null), fetchInvoiceStates: vi.fn(), signMismatchReason: vi.fn(), skipReasonForInvoice: vi.fn(),
}));

import { ALREADY_ALLOCATED, ZERO_AMOUNT, partitionAllocationLines, skipReasonFor } from '@/lib/mcp/tools/bulkAllocationSkip';
import { findBankTransactionAllocationStates } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import type { BankTransactionAllocationState } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import type { ResolvedLine } from '@/lib/mcp/tools/bulkAllocationPrepare';

const state = (over: Partial<BankTransactionAllocationState> = {}): BankTransactionAllocationState => ({
  id: 't', status: 'imported', matchedJournalLineId: null, feedState: 'posted', amount: -10, ...over,
});

describe('skipReasonFor and a zero amount', () => {
  it('names an importable zero-amount row zero_amount, in the exact wording the brief fixed', () => {
    expect(ZERO_AMOUNT).toBe('zero_amount');
    expect(skipReasonFor(state({ amount: 0 }))).toBe('zero_amount');
    expect(skipReasonFor(state({ amount: -0 }))).toBe('zero_amount');
  });

  it('leaves a non-zero importable row postable, including a one-cent line', () => {
    expect(skipReasonFor(state({ amount: -0.01 }))).toBeNull();
    expect(skipReasonFor(state({ amount: 0.01 }))).toBeNull();
  });

  it('keeps the more informative reason for a zero row that is also allocated, excluded, pending or removed', () => {
    expect(skipReasonFor(state({ amount: 0, matchedJournalLineId: 'jl', status: 'allocated' }))).toBe(ALREADY_ALLOCATED);
    expect(skipReasonFor(state({ amount: 0, status: 'excluded' }))).toBe('excluded');
    expect(skipReasonFor(state({ amount: 0, feedState: 'pending' }))).toBe('pending at the bank');
    expect(skipReasonFor(state({ amount: 0, feedState: 'removed' }))).toBe('removed by the bank');
  });
});

describe('partitionAllocationLines with a zero row', () => {
  it('skips it with the caller\'s index and the row id, and keeps the others postable', async () => {
    const mk = (index: number, txId: string): ResolvedLine => ({
      index, txId, line: { allocType: 'account', contraAccountId: 'acc' },
    } as unknown as ResolvedLine);
    vi.mocked(findBankTransactionAllocationStates).mockResolvedValue(new Map([
      ['a', state({ id: 'a', amount: -5 })], ['z', state({ id: 'z', amount: 0 })], ['b', state({ id: 'b', amount: 7 })],
    ]));
    const out = await partitionAllocationLines('co', [mk(0, 'a'), mk(1, 'z'), mk(2, 'b')], 'u');
    expect(out.skipped).toEqual([{ index: 1, transaction_id: 'z', reason: 'zero_amount' }]);
    expect(out.postable.map((p) => p.txId)).toEqual(['a', 'b']);
  });
});
