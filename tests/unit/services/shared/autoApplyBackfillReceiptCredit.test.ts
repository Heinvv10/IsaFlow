/**
 * The back-fill's AR credit-ceiling skip (shared/autoApplyBackfillReceiptCredit): sources walked in run order, each
 * assumed to consume its whole remainder from its own date, skipped when that leaves the customer's running credit
 * below zero on a date it lowers. The per-day figures stand in for their SQL (proven in the
 * ar-receipt-application-after-refund integration suite); dates are matched through one spelling (`dayKey`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerRunningCredit', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/customerRunningCredit')>()),
  customerCreditDays: vi.fn(),
}));

import { customerCreditDays } from '@/modules/accounting/services/ar/customerRunningCredit';
import { SKIP_RECEIPT_CREDIT_CEILING, markReceiptCreditSkips } from '@/modules/accounting/services/shared/autoApplyBackfillReceiptCredit';
import type { BackfillSource } from '@/modules/accounting/services/shared/autoApplyBackfillPlan';

const day = (d: string | Date, amount: number) => ({ d: d as string, amount, removed: 0, lowers: 0, others: amount });
const src = (paymentId: string, paymentDate: string, remainder: number, over: Partial<BackfillSource> = {}): BackfillSource => ({
  kind: 'payment', paymentId, paymentNumber: paymentId, entityId: 'cust', entityName: 'Acme', paymentDate, remainder,
  journalEntryId: 'je', skippedReason: null, ...over,
});
beforeEach(() => { vi.mocked(customerCreditDays).mockReset(); });

describe('markReceiptCreditSkips', () => {
  it('skips a source whose remainder a later refund already returned — the day it sits on is the source\'s own', async () => {
    // receipt 200 on 05-02 (a Date as pg returns it), refund -150 on 05-04: only 50 may be applied
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day(new Date(2026, 4, 2), 200), day('2026-05-04', -150)] });
    const out = await markReceiptCreditSkips('co', 'ar', [src('r1', '2026-05-02', 200)]);
    expect(out[0]!.skippedReason).toBe(SKIP_RECEIPT_CREDIT_CEILING);
  });
  it('a source the credit covers is matched to ITS day however the day is spelled — no false skip', async () => {
    // 50 of the receipt's 200 is still on account after the refund: matched to 05-02, nothing goes below zero
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day(new Date(2026, 4, 2), 200), day('2026-05-04', -150)] });
    const out = await markReceiptCreditSkips('co', 'ar', [src('r1', '2026-05-02', 50)]);
    expect(out[0]!.skippedReason).toBeNull();
  });
  it('lets a covered source through, and an earlier one\'s consumption counts against the next', async () => {
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day('2026-05-02', 100), day('2026-05-03', 100), day('2026-05-04', -50)] });
    const out = await markReceiptCreditSkips('co', 'ar', [src('r1', '2026-05-02', 100), src('r2', '2026-05-03', 100)]);
    // r1 alone: 05-04 reads 50 after it; r1 then r2: 05-04 would read -50
    expect(out.map((s) => s.skippedReason)).toEqual([null, SKIP_RECEIPT_CREDIT_CEILING]);
  });
  it('a skipped source consumes nothing; AP and already-skipped sources are untouched', async () => {
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day('2026-05-02', 100), day('2026-05-03', 30), day('2026-05-04', -60)] });
    const out = await markReceiptCreditSkips('co', 'ar', [src('r1', '2026-05-02', 100), src('r2', '2026-05-03', 30),
      src('r3', '2026-05-03', 5, { skippedReason: 'other' })]);
    expect(out.map((s) => s.skippedReason)).toEqual([SKIP_RECEIPT_CREDIT_CEILING, null, 'other']);
    expect(await markReceiptCreditSkips('co', 'ap', [src('p1', '2026-05-02', 100)])).toEqual([src('p1', '2026-05-02', 100)]);
  });
});
