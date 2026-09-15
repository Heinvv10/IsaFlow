/**
 * A counterparty leg that is still PENDING at the bank may never be selected as
 * the opposite leg of a controlled transfer.
 *
 * Master's commit 25f9d62a9 fenced eleven bank writers with feed_state =
 * 'posted'. The controlled transfer family it never reached picks its opposite
 * leg on status = 'imported' alone — and a pending feed row carries exactly
 * that status. Linking one trips migration 675's BEFORE UPDATE guard (ERRCODE
 * 23514) from inside `executeControlledOperation`, which aborts the whole
 * controlled operation and rolls the SOURCE leg back with it. The caller sees
 * an unmapped 500 on a transfer that was otherwise perfectly legal.
 *
 * A pending leg is EXCLUDED from selection rather than refused: the operator
 * named the source line and the counterparty ACCOUNT, never this row — the
 * system chose it. Excluding it posts the transfer with the opposite leg
 * unlinked, which is the already-supported outcome when no counterparty row
 * exists yet (`oppositeBankTransactionId: null`), and the row links when it
 * posts. Refusing would block a legal transfer on a row the operator cannot
 * act on and has no remedy for.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';

const readBankTransferCandidates = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankAllocationTransferSources', () => ({
  readBankTransferCandidates: (...args: unknown[]) => readBankTransferCandidates(...(args as [])),
  lockBankTransferPair: vi.fn(),
}));

const { bindBankTransferSelection } = await import(
  '@/modules/accounting/services/bank/bankAllocationTransferPreparation'
);

const SOURCE = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const PENDING_LEG = '33333333-3333-4333-8333-333333333333';
const POSTED_LEG = '44444444-4444-4444-8444-444444444444';

const request = { version: 1 as const, kind: 'transfer' as const, bankTransactionId: SOURCE, counterpartyAccountId: COUNTERPARTY_ACCOUNT };

function candidates(opposite: Record<string, unknown>[]) {
  readBankTransferCandidates.mockResolvedValue({
    bank: { id: SOURCE, status: 'imported', feed_state: 'posted' },
    oppositeCandidates: opposite,
    existingCandidates: [],
  });
}

const ctx = {} as ControlTx;

describe('controlled transfer opposite-leg selection', () => {
  it('does not select a pending counterparty leg', async () => {
    candidates([{ id: PENDING_LEG, status: 'imported', feed_state: 'pending' }]);
    const plan = await bindBankTransferSelection(ctx, request);
    expect(plan.transfer).toEqual({ mode: 'post', oppositeBankTransactionId: null });
  });

  it('does not select a removed counterparty leg', async () => {
    candidates([{ id: PENDING_LEG, status: 'imported', feed_state: 'removed' }]);
    const plan = await bindBankTransferSelection(ctx, request);
    expect(plan.transfer).toEqual({ mode: 'post', oppositeBankTransactionId: null });
  });

  it('skips past a pending leg to the best posted one', async () => {
    candidates([
      { id: PENDING_LEG, status: 'imported', feed_state: 'pending' },
      { id: POSTED_LEG, status: 'imported', feed_state: 'posted' },
    ]);
    const plan = await bindBankTransferSelection(ctx, request);
    expect(plan.transfer).toEqual({ mode: 'post', oppositeBankTransactionId: POSTED_LEG });
  });

  it('still selects the first posted leg when nothing is pending', async () => {
    candidates([{ id: POSTED_LEG, status: 'imported', feed_state: 'posted' }]);
    const plan = await bindBankTransferSelection(ctx, request);
    expect(plan.transfer).toEqual({ mode: 'post', oppositeBankTransactionId: POSTED_LEG });
  });

  it('refuses a candidate row whose SELECT omitted feed_state rather than assuming it posted', async () => {
    candidates([{ id: POSTED_LEG, status: 'imported' }]);
    await expect(bindBankTransferSelection(ctx, request)).rejects.toThrow(/feed_state/);
  });
});
