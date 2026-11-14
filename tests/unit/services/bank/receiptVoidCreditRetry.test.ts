/**
 * The receipt credit refusal (ar/customerVoidCredit, 2026-11-14) in the calls that reverse several lines at once: it is
 * retried after the rest exactly as the supplier one is (`bank/reverseLinesCreditLast`, a run undo's
 * `autoPostUndoAttempt`), and only it — any other receipt refusal stops the call.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { reverseLinesCreditLast } from '@/modules/accounting/services/bank/reverseLinesCreditLast';
import { attemptUndoRow, type UndoTally } from '@/modules/accounting/services/bank/autoPostUndoAttempt';
import { CustomerVoidCreditRefusal } from '@/modules/accounting/services/ar/customerVoidCredit';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';

describe('reverseLinesCreditLast — a receipt refused for credit', () => {
  it('is set aside and retried once after every other line', async () => {
    const seen: string[] = [];
    let refundReversed = false;
    await reverseLinesCreditLast(['receipt', 'refund'], async (id) => {
      seen.push(id);
      if (id === 'refund') refundReversed = true;
      else if (!refundReversed) throw new CustomerVoidCreditRefusal('a refund spent it');
    });
    expect(seen).toEqual(['receipt', 'refund', 'receipt']);
  });
  it('is rethrown when it is refused again', async () => {
    await expect(reverseLinesCreditLast(['receipt'], async () => { throw new CustomerVoidCreditRefusal('still spent'); }))
      .rejects.toThrow('still spent');
  });
  it('any other receipt refusal stops the call at once', async () => {
    const seen: string[] = [];
    await expect(reverseLinesCreditLast(['a', 'b'], async (id) => { seen.push(id); throw new ReceiptRefusal('other'); }))
      .rejects.toThrow('other');
    expect(seen).toEqual(['a']);
  });
});

describe('attemptUndoRow — a receipt refused for credit', () => {
  const tally = (): UndoTally => ({
    reversed: 0, alreadyUndone: 0, handOffsets: [], contention: null,
    skippedBy: { reconciled: 0, contended: 0, failed: 0, offsetByHand: 0, creditCeiling: 0 },
  });
  const ctx = { companyId: 'co', runId: 'run', txId: 'tx', status: 'allocated' };
  const refuse = async (): Promise<never> => { throw new CustomerVoidCreditRefusal('a refund spent it'); };
  it('is handed back for the retry on the first pass', async () => {
    const t = tally();
    expect(await attemptUndoRow(ctx, t, refuse, false)).toBe('creditRefused');
    expect(t.skippedBy).toMatchObject({ creditCeiling: 0, failed: 0 });
  });
  it('is a creditCeiling skip on the retry, not a failure', async () => {
    const t = tally();
    expect(await attemptUndoRow(ctx, t, refuse, true)).toBe('counted');
    expect(t.skippedBy).toMatchObject({ creditCeiling: 1, failed: 0 });
  });
});
