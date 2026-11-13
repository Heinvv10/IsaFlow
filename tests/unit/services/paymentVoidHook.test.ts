/**
 * voidPaymentDocument's `beforeFirstWrite` hook (void_payment undo_share, step 6). What void_payment's undo relies on:
 * the hook runs with the void's locks held and BEFORE its first write on every shape (bank line, journal, no journal,
 * bank-first settlement); a throw from it means nothing was written; and it is never called on a refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/modules/accounting/services/core/paymentLock', async () => ({
  ...(await vi.importActual<typeof import('@/modules/accounting/services/core/paymentLock')>(
    '@/modules/accounting/services/core/paymentLock')),
  lockCustomerPaymentForUpdate: vi.fn(),
  lockSupplierPaymentForUpdate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationUnwind', () => ({
  unwindOnePayment: vi.fn(), unwindBankAllocationApplication: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ reverseReconciledTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({ lockBankTransactionsInIdOrder: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ reverseJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/paymentJournalReversal', () => ({
  lockBankLegOf: vi.fn(async (_c: string, journalId: string) => ({
    alreadyReversed: false, reverseId: journalId, bankLineIds: [], seenLineIds: [], allocatedLineIds: [],
  })),
  lockJournalAndUnmatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/provisionalSettlementVoid', () => ({ voidSettlementDocument: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/chainBankLines', () => ({ findChainBankLines: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/bank/splitJournalDocuments', () => ({ splitPartRefusal: vi.fn(async () => null) }));

import { sql } from '@/lib/neon';
import { lockSupplierPaymentForUpdate } from '@/modules/accounting/services/core/paymentLock';
import { unwindBankAllocationApplication, unwindOnePayment } from '@/modules/accounting/services/bank/bankAllocationUnwind';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { lockJournalAndUnmatch } from '@/modules/accounting/services/ap/paymentJournalReversal';
import { voidSettlementDocument } from '@/modules/accounting/services/ap/provisionalSettlementVoid';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const PAY = '77777777-7777-4777-8777-777777777777';
const JE = '88888888-8888-4888-8888-888888888888';
const BANK_TX = '99999999-9999-4999-8999-999999999999';
let order: string[];

/** The locked payment, then the unlocked peek and the bank-line lookup the void makes first. */
function given(row: Record<string, unknown> | null, bankLines: unknown[] = []): void {
  vi.mocked(lockSupplierPaymentForUpdate).mockImplementation(async () => {
    order.push('lock'); return row as never;
  });
  const m = vi.mocked(sql);
  m.mockResolvedValueOnce((row ? [{ gl_journal_entry_id: row.gl_journal_entry_id ?? null }] : []) as never);
  if (row?.gl_journal_entry_id) m.mockResolvedValueOnce(bankLines as never);
}
const row = (over: Record<string, unknown> = {}) => ({
  id: PAY, payment_number: 'SP-1', status: 'processed', gl_journal_entry_id: JE, ...over,
});
const hook = vi.fn(async () => { order.push('hook'); });

describe('voidPaymentDocument beforeFirstWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sql).mockReset();
    order = [];
    const write = (name: string, result: unknown) => async () => { order.push(name); return result as never; };
    vi.mocked(unwindBankAllocationApplication).mockImplementation(write('unwind', { invoicesReopened: 1, amountUnapplied: 5, paymentsCancelled: 1 }));
    vi.mocked(unwindOnePayment).mockImplementation(write('unwind', { invoicesReopened: 1, amountUnapplied: 5 }));
    vi.mocked(lockJournalAndUnmatch).mockImplementation(write('unmatch', undefined));
    vi.mocked(reverseJournalEntry).mockImplementation(write('reverse', { vatLockRoll: null }));
    vi.mocked(reverseReconciledTransaction).mockImplementation(write('bank-reverse', { invoicesReopened: 1, amountUnapplied: 5 }));
    vi.mocked(voidSettlementDocument).mockImplementation(write('settlement-void', { paymentId: PAY }));
  });

  it.each([
    ['a journal, no bank line', row(), [] as unknown[]],
    ['no journal', row({ gl_journal_entry_id: null }), [] as unknown[]],
    ['a bank line', row(), [{ id: BANK_TX }]],
    ['a bank-first settlement', row({ settles_provisional_je_id: JE }), [] as unknown[]],
  ])('runs after the payment lock and before the first write — %s', async (_n, r, lines) => {
    given(r, lines);
    await voidPaymentDocument(COMPANY, 'supplier', PAY, USER, { beforeFirstWrite: hook });
    expect(order[0]).toBe('lock');
    expect(order[1]).toBe('hook');
    expect(order.length).toBeGreaterThan(2);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      id: PAY, journalEntryId: r.gl_journal_entry_id, bankTransactionId: lines.length ? BANK_TX : null,
    }));
  });

  it('a throw from the hook means nothing was written', async () => {
    given(row());
    await expect(voidPaymentDocument(COMPANY, 'supplier', PAY, USER, {
      beforeFirstWrite: async () => { throw new Error('refused by the plan'); },
    })).rejects.toThrow('refused by the plan');
    expect(order).toEqual(['lock']);
  });

  it.each([
    ['not found', null],
    ['already cancelled', row({ status: 'cancelled' })],
    ['not applied', row({ status: 'approved' })],
    ['a batch member', row({ batch_id: '66666666-6666-4666-8666-666666666666' })],
  ])('is not called on a refusal — %s', async (_n, r) => {
    given(r);
    const out = await voidPaymentDocument(COMPANY, 'supplier', PAY, USER, { beforeFirstWrite: hook });
    expect(out).toHaveProperty('refusal');
    expect(hook).not.toHaveBeenCalled();
  });

  it('is not handed on to the reversal or the bank path', async () => {
    given(row());
    await voidPaymentDocument(COMPANY, 'supplier', PAY, USER, { beforeFirstWrite: hook, postingAgent: 'mcp:void_payment' });
    expect(vi.mocked(reverseJournalEntry).mock.calls[0]![3]).toEqual({ postingAgent: 'mcp:void_payment' });
  });
});
