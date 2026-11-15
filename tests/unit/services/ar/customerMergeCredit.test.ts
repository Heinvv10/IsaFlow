/**
 * The customer merge's running-credit guard (ar/customerMergeCredit): the rule is `judgeCreditDays`'s, applied to the
 * TARGET's rows as the merge left them. Pure arithmetic is pinned here on figures; the SQL and the rollback are proven
 * on a real ledger in tests/integration/ar-customer-merge-running-credit.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const daysMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerRunningCredit', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/customerRunningCredit')>()),
  customerCreditDays: daysMock,
}));

import type { CreditDay } from '@/modules/accounting/services/ar/customerRunningCredit';
import {
  CustomerMergeCreditRefusal, assertMergeKeepsCredit, mergeCreditShortfall,
} from '@/modules/accounting/services/ar/customerMergeCredit';
import { ArRequestError } from '@/modules/accounting/services/ar/arErrors';

/** A target day AFTER the move: `amount` is every live row, `src` the part that came from the source. */
const day = (d: string, amount: number, src = 0, srcPositive = Math.max(src, 0)): CreditDay =>
  ({ d, amount, removed: src, lowers: srcPositive, others: amount - src });

describe('mergeCreditShortfall — the target as the merge left it', () => {
  it('a merge that leaves every date at or above zero is never refused', () => {
    expect(mergeCreditShortfall([day('2026-05-05', 100, 100), day('2026-05-10', 0, -100)])).toBeNull();
  });
  it('a source refund that exceeds the receipts on account on some date is refused, naming that date', () => {
    expect(mergeCreditShortfall([day('2026-05-05', 100, 0), day('2026-05-10', -200, -300)]))
      .toEqual({ date: '2026-05-10', credit: -100 });
  });
  it('already negative on its own (a source refund with no receipt): refused', () => {
    expect(mergeCreditShortfall([day('2026-05-10', -50, -50)])).toEqual({ date: '2026-05-10', credit: -50 });
  });
  it('date edge: the target receipt must come on or before the source refund', () => {
    // target receipt 100 on 05-10, source refund -100 on 05-05: negative on 05-05 even though the total is 0
    const days = [day('2026-05-05', -100, -100), day('2026-05-10', 100, 0)];
    expect(mergeCreditShortfall(days)).toEqual({ date: '2026-05-05', credit: -100 });
    // refund AFTER the receipt: covered on every date
    expect(mergeCreditShortfall([day('2026-05-05', 100, 0), day('2026-05-10', -100, -100)])).toBeNull();
    // the same day nets, as the rule counts a day at a time
    expect(mergeCreditShortfall([day('2026-05-05', 0, -100, 0)])).toBeNull();
  });
  it('a negative date the merge does not lower is not the merge\'s to refuse (the source adds nothing there)', () => {
    // target alone is -40 on 05-01 (legacy); the source's positive receipt arrives 05-02: the merge only raised it
    expect(mergeCreditShortfall([day('2026-05-01', -40, 0), day('2026-05-02', 60, 100)])).toBeNull();
  });
  it('a date the merge deepens is refused even when the target was already negative there', () => {
    expect(mergeCreditShortfall([day('2026-05-01', -40, 0), day('2026-05-02', -50, -50)]))
      .toEqual({ date: '2026-05-02', credit: -90 });
  });
  it('rounds in whole cents', () => {
    expect(mergeCreditShortfall([day('2026-05-05', 0.1 + 0.2 - 0.3, 0), day('2026-05-06', 0, -0.1 - 0.2 + 0.3)])).toBeNull();
  });
});

describe('assertMergeKeepsCredit', () => {
  const rows: unknown[][] = [];
  const tx = vi.fn(async () => rows.shift() ?? []);
  beforeEach(() => { daysMock.mockReset(); tx.mockClear(); rows.length = 0; });

  it('reads the TARGET\'s real rows through the merge\'s own transaction, the moved receipts as the removals', async () => {
    daysMock.mockResolvedValue({ customerName: 'Target Co', days: [day('2026-05-05', 100, 100)] });
    await assertMergeKeepsCredit(tx, 'c1', 's1', 't1', ['p1', 'p2']);
    expect(daysMock).toHaveBeenCalledWith('c1', 't1', [{ paymentId: 'p1' }, { paymentId: 'p2' }], tx);
  });
  it('reads nothing when no receipt moved: the merge added no cash to judge', async () => {
    await assertMergeKeepsCredit(tx, 'c1', 's1', 't1', []);
    expect(daysMock).not.toHaveBeenCalled();
  });
  it('refuses with the customers\' names, the date and the figure, as a 400 CUSTOMER_MERGE_CREDIT_REFUSED', async () => {
    daysMock.mockResolvedValue({ customerName: 'Target Co', days: [day('2026-05-10', -50, -50)] });
    rows.push([{ name: 'Source Co' }]);
    const err = await assertMergeKeepsCredit(tx, 'c1', 's1', 't1', ['p1']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomerMergeCreditRefusal);
    expect(err).toBeInstanceOf(ArRequestError);
    expect(err).toMatchObject({ status: 400, code: 'CUSTOMER_MERGE_CREDIT_REFUSED' });
    expect((err as Error).message).toMatch(/Merging Source Co into Target Co would leave Target Co owing the company/);
    expect((err as Error).message).toMatch(/from 2026-05-10/);
    expect((err as Error).message).toMatch(/Nothing was merged/);
  });
});
