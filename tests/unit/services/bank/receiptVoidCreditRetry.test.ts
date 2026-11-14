/**
 * The receipt credit refusal (ar/customerVoidCredit, 2026-11-14) in the calls that reverse several lines at once: the
 * all-or-nothing bulk reversals judge receipts once up front, so `bank/reverseLinesCreditLast` retries only the
 * supplier refusal; a run undo (`autoPostUndoAttempt`, row by row) retries the receipt one after its other rows.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { reverseLinesCreditLast } from '@/modules/accounting/services/bank/reverseLinesCreditLast';
import { attemptUndoRow, type UndoTally } from '@/modules/accounting/services/bank/autoPostUndoAttempt';
import { CustomerVoidCreditRefusal } from '@/modules/accounting/services/ar/customerVoidCredit';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { SupplierVoidCreditRefusal } from '@/modules/accounting/services/ap/supplierVoidCredit';

describe('reverseLinesCreditLast — a receipt refused for credit', () => {
  // The bulk reversals judge a customer's receipts ONCE up front (reverseLinesJudged); the retry is the supplier's.
  it('is not set aside: it stops the call at once, as any other refusal does', async () => {
    const seen: string[] = [];
    await expect(reverseLinesCreditLast(['receipt', 'refund'], async (id) => {
      seen.push(id);
      if (id === 'receipt') throw new CustomerVoidCreditRefusal('a refund spent it');
    })).rejects.toThrow('a refund spent it');
    expect(seen).toEqual(['receipt']);
  });
  it('a supplier credit refusal is still retried after the rest', async () => {
    const seen: string[] = [];
    let refundReversed = false;
    await reverseLinesCreditLast(['payment', 'refund'], async (id) => {
      seen.push(id);
      if (id === 'refund') refundReversed = true;
      else if (!refundReversed) throw new SupplierVoidCreditRefusal('a refund returned it');
    });
    expect(seen).toEqual(['payment', 'refund', 'payment']);
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
