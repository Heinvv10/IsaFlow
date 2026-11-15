/**
 * The customer merge's running-credit guard (ar/customerMergeCredit): the merged account is judged symmetrically — below
 * zero on ANY date is refused, whichever customer is the source. Pure arithmetic is pinned here on figures; the SQL, the
 * allocation basis and the rollback are proven on a real ledger in
 * tests/integration/ar-customer-merge-running-credit.int.test.ts.
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

const day = (d: string, amount: number): CreditDay => ({ d, amount, removed: 0, lowers: 0, others: amount });

describe('mergeCreditShortfall — the merged account, by date', () => {
  it('every date at or above zero is never refused', () => {
    expect(mergeCreditShortfall([day('2026-05-05', 100), day('2026-05-10', -100)])).toBeNull();
    expect(mergeCreditShortfall([])).toBeNull();
  });
  it('the first date below zero is named, with the running figure', () => {
    expect(mergeCreditShortfall([day('2026-05-05', 100), day('2026-05-10', -200), day('2026-05-12', -50)]))
      .toEqual({ date: '2026-05-10', credit: -100 });
  });
  it('is judged by date, never on the total: a refund before the receipt that covers it is refused', () => {
    expect(mergeCreditShortfall([day('2026-05-05', -100), day('2026-05-10', 100)]))
      .toEqual({ date: '2026-05-05', credit: -100 });
    expect(mergeCreditShortfall([day('2026-05-05', 100), day('2026-05-10', -100)])).toBeNull();
  });
  it('a day nets: figures are already one per date', () => {
    expect(mergeCreditShortfall([day('2026-05-05', 0)])).toBeNull();
  });
  it('already negative with nothing moved is refused too (the merge would carry the negative over)', () => {
    expect(mergeCreditShortfall([day('2026-05-01', -40), day('2026-05-02', 25)])).toEqual({ date: '2026-05-01', credit: -40 });
  });
  it('does not depend on the order the days arrive in', () => {
    expect(mergeCreditShortfall([day('2026-05-10', 100), day('2026-05-05', -100)])).toEqual({ date: '2026-05-05', credit: -100 });
  });
  it('rounds in whole cents', () => {
    expect(mergeCreditShortfall([day('2026-05-05', 0.1 + 0.2), day('2026-05-06', -0.3)])).toBeNull();
    expect(mergeCreditShortfall([day('2026-05-05', 0.1 + 0.2), day('2026-05-06', -0.31)])).toEqual({ date: '2026-05-06', credit: -0.01 });
  });
});

describe('assertMergeKeepsCredit', () => {
  const rows: unknown[][] = [];
  const tx = vi.fn(async () => rows.shift() ?? []);
  beforeEach(() => { daysMock.mockReset(); tx.mockClear(); rows.length = 0; });

  it('reads the target\'s real rows, no removals, through the merge\'s own transaction', async () => {
    daysMock.mockResolvedValue({ customerName: 'Target Co', days: [day('2026-05-05', 100)] });
    await assertMergeKeepsCredit(tx, 'c1', 't1', 's1');
    expect(daysMock).toHaveBeenCalledWith('c1', 't1', [], tx);
    expect(tx).not.toHaveBeenCalled();
  });
  it('refuses with the customers\' names, the date and the figure, as a 400 carrying CUSTOMER_MERGE_CREDIT_REFUSED', async () => {
    daysMock.mockResolvedValue({ customerName: 'Target Co', days: [day('2026-05-10', -50)] });
    rows.push([{ name: 'Source Co' }]);
    const err = await assertMergeKeepsCredit(tx, 'c1', 't1', 's1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomerMergeCreditRefusal);
    expect(err).toBeInstanceOf(ArRequestError);
    expect(err).toMatchObject({ status: 400, code: 'CUSTOMER_MERGE_CREDIT_REFUSED' });
    const text = (err as Error).message;
    expect(text).toMatch(/Merging Source Co into Target Co would leave Target Co owing the company/);
    expect(text).toMatch(/from 2026-05-10/);
    expect(text).toMatch(/Nothing was merged/);
    expect(text).not.toMatch(/other way/i);
  });
});
