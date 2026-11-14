/**
 * reallocateReconciledTransaction's sequence, with every collaborator stubbed: the gates run before nothing_changed,
 * the documents are locked in the canonical pass BEFORE the unwind and the old journal head, the new journal is
 * posted before the old one is reversed, the reversal must keep the original date, and a customer receipt whose
 * remainder a refund paid out is refused before any write. The ledger effect is in
 * tests/integration/bank-reallocate-reconciled.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const step = (name: string, value?: unknown) => vi.fn(async () => { order.push(name); return value; });
const h = vi.hoisted(() => ({ plan: {} as Record<string, unknown> }));

vi.mock('@/lib/neon', () => ({ withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()), sql: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rowLockBudget', () => ({ underFlowLockBudget: vi.fn((_w: string, fn: () => unknown) => fn()) }));
vi.mock('@/modules/accounting/services/bank/bankChainLineReversal', () => ({
  peekLineChain: vi.fn(async () => ({ lineId: 'leg', journalId: 'je', rootId: 'je', doc: null })),
  lockChainLines: vi.fn(async () => []), refuseStaleUndo: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({
  lockBankTransactionForUpdate: vi.fn(async () => ({ id: 'tx', matched_journal_line_id: 'leg', reviewed_at: 'r-at', reviewed_by: 'r-by', auto_post_run_id: 'run' })),
}));
vi.mock('@/modules/accounting/services/bank/bankReallocationFacts', () => ({ loadReallocationFacts: vi.fn(async () => ({})) }));
vi.mock('@/modules/accounting/services/bank/bankReallocationGuards', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/bankReallocationGuards')>()),
  planReallocation: vi.fn(() => h.plan),
}));
vi.mock('@/modules/accounting/services/bank/bankReversalGate', () => ({
  agentReversalRefusal: vi.fn(), assertMayReverse: vi.fn(), auditedReversal: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReallocationLocks', () => ({ lockReallocationDocuments: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankReallocationCredit', () => ({
  assertReallocationKeepsCredit: vi.fn(), assertReallocationLeftCredit: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerRunningCredit', () => ({ customerCreditDays: vi.fn(async () => ({ customerName: 'A', days: [] })) }));
vi.mock('@/modules/accounting/services/ar/customerCreditLock', () => ({ tryLockCustomerCredit: vi.fn() }));
// The unwind runs inside the reallocation's receipt judgment (ar/customerVoidCredit); here it is transparent.
vi.mock('@/modules/accounting/services/ar/customerVoidCredit', () => ({
  withReceiptCancellationsJudged: vi.fn(async (_c: string, _ids: readonly string[], fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationUnwind', () => ({ unwindBankAllocationApplication: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/reversalDatePostable', () => ({ lockPeekedReversalTarget: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ allocateTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ reverseJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankReallocationWrites', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/bankReallocationWrites')>()),
  assertOriginalDateKept: vi.fn(), readBankLeg: vi.fn(), restoreReconciled: vi.fn(), auditReallocation: vi.fn(),
  assertBankLegKept: vi.fn(),
  newDocumentOf: vi.fn(async () => ({ kind: 'none', paymentId: null })),
}));

import { reallocateReconciledTransaction } from '@/modules/accounting/services/bank/bankReallocationService';
import { BankReallocationRefusal } from '@/modules/accounting/services/bank/bankReallocationGuards';
import { agentReversalRefusal, assertMayReverse } from '@/modules/accounting/services/bank/bankReversalGate';
import { lockReallocationDocuments } from '@/modules/accounting/services/bank/bankReallocationLocks';
import { assertReallocationKeepsCredit, assertReallocationLeftCredit } from '@/modules/accounting/services/bank/bankReallocationCredit';
import { tryLockCustomerCredit } from '@/modules/accounting/services/ar/customerCreditLock';
import { customerCreditDays } from '@/modules/accounting/services/ar/customerRunningCredit';
import { refuseStaleUndo } from '@/modules/accounting/services/bank/bankChainLineReversal';
import { BankControlError } from '@/modules/accounting/services/bank/bankControlRefusal';
import { unwindBankAllocationApplication } from '@/modules/accounting/services/bank/bankAllocationUnwind';
import { lockPeekedReversalTarget } from '@/modules/accounting/services/bank/reversalDatePostable';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import {
  assertBankLegKept, assertOriginalDateKept, auditReallocation, readBankLeg, restoreReconciled,
} from '@/modules/accounting/services/bank/bankReallocationWrites';

const LEG = { lineId: 'leg', glAccountId: 'bank', subtype: 'bank', debit: 0, credit: 100, vatType: null, cc1Id: null, cc2Id: null, buId: null };
const OPTS = { expectedJournalEntryId: 'je', autoApply: 'fifo' as const, postingAgent: 'mcp:t:v1' };
const run = () => reallocateReconciledTransaction('co', 'tx', 'u', { kind: 'supplier', supplierId: 's' }, OPTS);

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  h.plan = { kind: 'reallocate', reconciliationId: 'rec', journalId: 'je', entryDate: '2026-06-10', bankLeg: LEG };
  vi.mocked(agentReversalRefusal).mockImplementation(step('agentGate', null) as never);
  vi.mocked(assertMayReverse).mockImplementation(step('mayReverse', null) as never);
  vi.mocked(assertOriginalDateKept).mockImplementation(step('date') as never);
  vi.mocked(lockReallocationDocuments).mockImplementation(step('lockDocuments', { supplierPaymentIds: [], customerPaymentIds: ['r1'] }) as never);
  vi.mocked(assertReallocationKeepsCredit).mockImplementation(step('credit') as never);
  vi.mocked(refuseStaleUndo).mockImplementation(step('staleUndo') as never);
  vi.mocked(assertBankLegKept).mockImplementation(((...a: unknown[]) => { order.push('bankLeg'); void a;
    return { journalId: 'new-je', lineId: 'new', glAccountId: 'bank', debit: 0, credit: 100, entryDate: '2026-06-10' }; }) as never);
  vi.mocked(unwindBankAllocationApplication).mockImplementation(step('unwind', { invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 0 }) as never);
  vi.mocked(lockPeekedReversalTarget).mockImplementation(step('lockHead') as never);
  vi.mocked(allocateTransaction).mockImplementation(step('allocate', { journalEntryId: 'new-je', bankTransaction: { id: 'tx' } }) as never);
  vi.mocked(reverseJournalEntry).mockImplementation(step('reverse', { id: 'rev', entryDate: '2026-06-10' }) as never);
  vi.mocked(readBankLeg).mockResolvedValue({ journalId: 'new-je', lineId: 'new', glAccountId: 'bank', debit: 0, credit: 100, entryDate: '2026-06-10' });
  vi.mocked(restoreReconciled).mockImplementation(step('restore') as never);
  vi.mocked(auditReallocation).mockImplementation(step('audit') as never);
});

describe('reallocateReconciledTransaction', () => {
  it('gates -> date -> document locks -> credit -> unwind -> old head -> new journal -> reversal -> restore -> audit', async () => {
    const r = await run();
    expect(order).toEqual(['agentGate', 'mayReverse', 'date', 'lockDocuments', 'credit', 'unwind', 'lockHead', 'staleUndo',
      'allocate', 'reverse', 'bankLeg', 'restore', 'audit']);
    expect(vi.mocked(assertReallocationKeepsCredit).mock.calls[0]![1]).toEqual({ supplierPaymentIds: [], customerPaymentIds: ['r1'] });
    expect(vi.mocked(assertBankLegKept).mock.calls[0]!.slice(1, 2)).toEqual(['2026-06-10']);
    expect(vi.mocked(assertBankLegKept).mock.calls[0]![3]).toBe('new-je');
    expect(vi.mocked(lockReallocationDocuments).mock.calls[0]![1]).toEqual(
      { journalId: 'je', target: { kind: 'supplier', supplierId: 's' }, spent: true, autoApply: 'fifo' });
    expect(vi.mocked(reverseJournalEntry).mock.calls[0]![3]).toMatchObject({ reversalDate: '2026-06-10' });
    expect(vi.mocked(restoreReconciled).mock.calls[0]![4]).toEqual({ at: 'r-at', by: 'r-by' });
    expect(vi.mocked(auditReallocation).mock.calls[0]![0]).toMatchObject({ autoPostRunId: 'run', reviewed: { at: 'r-at', by: 'r-by' } });
    expect(r).toMatchObject({ outcome: 'reallocated', newJournalEntryId: 'new-je', reversalJournalEntryId: 'rev' });
  });

  it('money in to a customer: that customer locked and read first, deferred, then judged on the rows the write left', async () => {
    h.plan = { ...h.plan, bankLeg: { ...LEG, debit: 100, credit: 0 } };
    vi.mocked(tryLockCustomerCredit).mockImplementation(step('lockCustomer') as never);
    vi.mocked(customerCreditDays).mockImplementation(step('before', { customerName: 'A', days: [] }) as never);
    vi.mocked(assertReallocationLeftCredit).mockImplementation(step('leftCredit') as never);
    await reallocateReconciledTransaction('co', 'tx', 'u', { kind: 'customer', customerId: 'c' }, OPTS);
    expect(order).toEqual(['agentGate', 'mayReverse', 'date', 'lockDocuments', 'lockCustomer', 'before', 'credit', 'unwind',
      'lockHead', 'staleUndo', 'allocate', 'reverse', 'leftCredit', 'bankLeg', 'restore', 'audit']);
    expect(vi.mocked(assertReallocationKeepsCredit).mock.calls[0]![2]).toBe('c');
  });

  it('the post-write judgment refusing stops the flow inside the savepoint, before the restore', async () => {
    h.plan = { ...h.plan, bankLeg: { ...LEG, debit: 100, credit: 0 } };
    vi.mocked(assertReallocationLeftCredit).mockRejectedValueOnce(new BankReallocationRefusal('owing the company'));
    await expect(reallocateReconciledTransaction('co', 'tx', 'u', { kind: 'customer', customerId: 'c' }, OPTS))
      .rejects.toThrow('owing the company');
    expect(restoreReconciled).not.toHaveBeenCalled();
  });

  it('a reversal that did not keep the original date refuses (inside the savepoint), before the restore', async () => {
    vi.mocked(reverseJournalEntry).mockResolvedValue({ id: 'rev', entryDate: '2026-06-11' } as never);
    await expect(run()).rejects.toBeInstanceOf(BankReallocationRefusal);
    expect(restoreReconciled).not.toHaveBeenCalled();
  });

  it('an agent under enforcement is refused (agentReversalRefusal) before anything else', async () => {
    vi.mocked(agentReversalRefusal).mockResolvedValue(new BankControlError('AGENT_FORBIDDEN', 'an agent or a job cannot'));
    await expect(run()).rejects.toThrow(/an agent or a job cannot/);
    expect(assertMayReverse).not.toHaveBeenCalled();
    expect(lockReallocationDocuments).not.toHaveBeenCalled();
  });

  it('a credit-ceiling refusal stops the flow before any write', async () => {
    vi.mocked(assertReallocationKeepsCredit).mockRejectedValue(new BankReallocationRefusal('leave Acme owing the company'));
    await expect(run()).rejects.toThrow(/leave Acme owing the company/);
    expect(unwindBankAllocationApplication).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('nothing_changed is decided after the reversal gates, and writes nothing', async () => {
    h.plan = { ...h.plan, kind: 'nothing_changed' };
    const r = await run();
    expect(order).toEqual(['agentGate', 'mayReverse']);
    expect(r.outcome).toBe('nothing_changed');
  });

  it('a dry run is passed to the audit (it logs as one)', async () => {
    await reallocateReconciledTransaction('co', 'tx', 'u', { kind: 'supplier', supplierId: 's' }, { ...OPTS, dryRun: true });
    expect(vi.mocked(auditReallocation).mock.calls[0]![0]).toMatchObject({ dryRun: true });
  });
});
