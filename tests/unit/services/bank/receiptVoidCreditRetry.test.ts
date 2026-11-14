/**
 * The receipt credit refusal (ar/customerVoidCredit) in the calls that reverse several lines at once. The
 * all-or-nothing bulk reversals (`reverseLinesJudged`) judge the receipts on the lines' chain roots once, up front, and
 * reverse inside that judgment; `reverseLinesCreditLast` keeps its retry for the supplier refusal only. A run undo
 * (`autoPostUndoAttempt`, row by row) retries the receipt refusal after its other rows. Figures and SQL: the
 * ar-receipt-void-after-refund-bulk integration suite.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  // the receipts on the roots: one per root, named after it
  sql: vi.fn(async (strings: readonly string[], ...values: unknown[]) =>
    (strings.join('?').includes('FROM customer_payments cp')
      ? ((values.find(Array.isArray) ?? []) as string[]).map((root) => ({ id: `receipt-of-${root}` }))
      : [])),
}));
vi.mock('@/modules/accounting/services/shared/journalChainHead', () => ({
  findJournalChainRoot: vi.fn(async (_c: string, je: string) => `root-${je}`),
}));
vi.mock('@/modules/accounting/services/ar/customerVoidCredit', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/customerVoidCredit')>()),
  withReceiptCancellationsJudged: vi.fn(async (_c: string, _ids: readonly string[], fn: () => Promise<unknown>) => fn()),
}));

import { reverseLinesCreditLast, reverseLinesJudged } from '@/modules/accounting/services/bank/reverseLinesCreditLast';
import { attemptUndoRow, type UndoTally } from '@/modules/accounting/services/bank/autoPostUndoAttempt';
import { CustomerVoidCreditRefusal, withReceiptCancellationsJudged } from '@/modules/accounting/services/ar/customerVoidCredit';
import { SupplierVoidCreditRefusal } from '@/modules/accounting/services/ap/supplierVoidCredit';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';

describe('reverseLinesJudged — the bulk reversal judges the receipts on its lines, then reverses inside that', () => {
  it('passes the receipts on the lines\' chain roots to ONE judgment, and reverses every line inside it', async () => {
    const seen: string[] = [];
    vi.mocked(withReceiptCancellationsJudged).mockImplementationOnce(async (_c, ids, fn) => {
      seen.push(`judge ${[...ids].join(',')}`);
      return fn();
    });
    await reverseLinesJudged('co', [{ id: 'l1', journalEntryId: 'je1' }, { id: 'l2', journalEntryId: null }, { id: 'l3', journalEntryId: 'je3' }],
      async (id) => { seen.push(`reverse ${id}`); });
    expect(seen).toEqual(['judge receipt-of-root-je1,receipt-of-root-je3', 'reverse l1', 'reverse l2', 'reverse l3']);
    expect(withReceiptCancellationsJudged).toHaveBeenCalledTimes(1);
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
  it('a customer credit refusal is NOT set aside and retried: it stops the call at once', async () => {
    const seen: string[] = [];
    await expect(reverseLinesCreditLast(['receipt', 'refund'], async (id) => {
      seen.push(id);
      if (id === 'receipt') throw new CustomerVoidCreditRefusal('a refund spent it');
    })).rejects.toThrow('a refund spent it');
    expect(seen).toEqual(['receipt']);
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
