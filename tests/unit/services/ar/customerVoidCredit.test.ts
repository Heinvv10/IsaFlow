/**
 * The receipt credit rule (ar/customerRunningCredit.judgeCreditDays — pure, so the arithmetic is pinned here on
 * figures) and the refusals built on it (ar/customerVoidCredit): wording, when the customer lock is taken, and the
 * bulk judgment's verification. The SQL that reads the figures, and the lock's behaviour against a refund, are proven
 * on a real ledger in tests/integration/ar-receipt-*.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/ar/customerCreditLock', () => ({ tryLockCustomerCredit: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerRunningCredit', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/customerRunningCredit')>()),
  customerCreditDays: vi.fn(),
}));

import { judgeCreditDays, customerCreditDays, withDatedRemovals, type CreditDay } from '@/modules/accounting/services/ar/customerRunningCredit';
import {
  CustomerVoidCreditRefusal, assertReceiptApplicationKeepsCredit, assertReceiptVoidKeepsCredit, customerCreditFall,
  isCustomerVoidCreditRefusal, withReceiptCancellationsJudged,
} from '@/modules/accounting/services/ar/customerVoidCredit';
import { tryLockCustomerCredit } from '@/modules/accounting/services/ar/customerCreditLock';
import { ReceiptRefusal, isRetryableReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { safeErrorText } from '@/lib/mcp/tools/toolHelpers';

const day = (d: string, amount: number, removed = 0, others = amount - removed): CreditDay =>
  ({ d, amount, removed, lowers: Math.max(removed, 0), others });

describe('judgeCreditDays — the rule', () => {
  it('one receipt: refused exactly when its remainder exceeds the lowest running credit from its date (R2-2)', () => {
    // receipt 500 on 05-05, refund -500 on 05-10, a later receipt 500 on 05-20: the all-dates figure is 500
    const days = [day('05-05', 500, 500), day('05-10', -500), day('05-20', 500)];
    expect(judgeCreditDays(days)).toEqual({ fromDate: '05-05', lowers: 500, lowest: 0, lowestAfter: -500 });
    expect(judgeCreditDays([day('05-05', 500), day('05-10', -500), day('05-20', 500, 500)]).lowestAfter).toBe(0);
  });
  it('several receipts are judged by date, not "sum lowered vs lowest from the earliest date"', () => {
    const j = judgeCreditDays([day('05-16', 50, 50), day('05-18', 100, 100)]);
    expect(j).toEqual({ fromDate: '05-16', lowers: 150, lowest: 50, lowestAfter: 0 }); // 150 > 50, yet nothing < 0
  });
  it('a receipt and its refund together lower no date', () => {
    expect(judgeCreditDays([day('05-20', 0), day('05-22', -50, -50), day('05-24', 50, 50), day('05-27', -150)]).lowestAfter)
      .toBeNull();
  });
  it('a customer below zero on a later date: a write that lowers that date is refused, one after it is judged alone', () => {
    const negativeLater = [day('05-05', 100, 100), day('05-10', -300)];
    expect(judgeCreditDays(negativeLater).lowestAfter).toBe(-300);
    expect(judgeCreditDays([day('05-08', -60), day('05-12', 100), day('05-14', 40, 40)]).lowestAfter).toBe(40);
  });
  it('a dated removal lands on its own day whichever way either date is spelled', () => {
    const out = withDatedRemovals([day('2026-05-02', 200)], [{ date: new Date(2026, 4, 2), amount: 50 }, { date: '2026-05-09', amount: 10 }]);
    expect(out.map((d) => [d.d, d.removed])).toEqual([['2026-05-02', 50], ['2026-05-09', 10]]);
  });
  it('a write that lowers nothing has no figure to refuse on', () => {
    expect(judgeCreditDays([day('05-05', 0, 0), day('05-10', -300)])).toMatchObject({ fromDate: null, lowestAfter: null });
  });
});

/** removedRows' answer: the receipts named, with customer and remainder. */
const rows = (...r: [string, string, number][]) => r.map(([id, customer_id, remainder]) => ({ id, customer_id, remainder }));

beforeEach(() => { sqlMock.mockReset(); vi.mocked(customerCreditDays).mockReset(); vi.mocked(tryLockCustomerCredit).mockClear(); });

describe('assertReceiptVoidKeepsCredit / assertReceiptApplicationKeepsCredit', () => {
  it('refuses a cancel, naming the customer, what it lowers, the lowest credit and the date, as RECEIPT_REFUSED', async () => {
    sqlMock.mockResolvedValueOnce(rows(['r1', 'c', 1000]));
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day('2026-05-05', 1000, 1000), day('2026-05-10', -1000)] });
    const err = await assertReceiptVoidKeepsCredit('co', ['r1']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomerVoidCreditRefusal);
    expect(isCustomerVoidCreditRefusal(err)).toBe(true);
    const text = safeErrorText(err, 'fallback');
    expect(text).toMatch(/^Cancelling this receipt would leave Acme owing the company: it takes R\s?1[\s,]?000\.00 .* from 2026-05-05, .* only R\s?0\.00 is on account/);
    expect(tryLockCustomerCredit).toHaveBeenCalledWith('co', 'c');
  });
  it('words an application by its amount, with its own remedy', async () => {
    sqlMock.mockResolvedValueOnce(rows(['r1', 'c', 200]));
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day('2026-05-02', 200, 200), day('2026-05-04', -150)] });
    await expect(assertReceiptApplicationKeepsCredit('co', 'r1', 200)).rejects.toThrow(/^Applying R\s?200\.00 of this receipt .* apply only what is still on account\.$/);
    expect(vi.mocked(customerCreditDays).mock.calls[0]![2]).toEqual([{ paymentId: 'r1', amount: 200 }]);
  });
  it('an application removes only the amount applied, not the receipt\'s whole remainder', async () => {
    sqlMock.mockResolvedValueOnce(rows(['r1', 'c', 200]));
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day('2026-05-02', 200, 50), day('2026-05-04', -150)] });
    await expect(assertReceiptApplicationKeepsCredit('co', 'r1', 50)).resolves.toBeUndefined();
    expect(vi.mocked(customerCreditDays).mock.calls[0]![2]).toEqual([{ paymentId: 'r1', amount: 50 }]);
  });
  it('a fully applied receipt lowers nothing: no lock, no figures, no refusal', async () => {
    sqlMock.mockResolvedValueOnce(rows(['r1', 'c', 0]));
    await expect(assertReceiptVoidKeepsCredit('co', ['r1'])).resolves.toBeUndefined();
    expect(tryLockCustomerCredit).not.toHaveBeenCalled();
    expect(customerCreditDays).not.toHaveBeenCalled();
  });
  it('a plain receipt refusal is not the credit refusal', () => {
    expect(isCustomerVoidCreditRefusal(new ReceiptRefusal('x'))).toBe(false);
  });
});

describe('withReceiptCancellationsJudged — judged once, each receipt only verifies', () => {
  const judgedDays = [day('2026-05-22', -50, -50, 0), day('2026-05-24', 50, 50, 0), day('2026-05-27', -150)];
  async function inJudgedCall(nowDays: CreditDay[], nowRemainder = 50, nowCustomer = 'c', refundCustomer = 'c') {
    sqlMock
      .mockResolvedValueOnce(rows(['ref', 'c', -50], ['rec', 'c', 50])) // the judgment's rows
      .mockResolvedValueOnce(rows(['rec', nowCustomer, nowRemainder])) // the receipt's own check: its row
      .mockResolvedValueOnce(rows(['ref', refundCustomer, -50], ['rec', 'c', nowRemainder])); // the set's rows now
    vi.mocked(customerCreditDays)
      .mockResolvedValueOnce({ customerName: 'Acme', days: judgedDays })
      .mockResolvedValueOnce({ customerName: 'Acme', days: nowDays });
    return withReceiptCancellationsJudged('co', ['ref', 'rec'], () => assertReceiptVoidKeepsCredit('co', ['rec']));
  }
  it('passes a set that lowers no date, and the receipt inside it is not judged again (breaker B)', async () => {
    await expect(inJudgedCall(judgedDays)).resolves.toBeUndefined();
    expect(customerCreditDays).toHaveBeenCalledTimes(2); // the judgment, then the verification — no second judgment
    expect(tryLockCustomerCredit).toHaveBeenCalledTimes(1); // judged unlocked; locked at the receipt's own step
  });
  it('refuses as retryable when another row of the customer fell since the judgment', async () => {
    const err = await inJudgedCall([...judgedDays.slice(0, 2), day('2026-05-27', -200)]).catch((e: unknown) => e);
    expect(isRetryableReceiptRefusal(err)).toBe(true);
    expect(isCustomerVoidCreditRefusal(err)).toBe(false);
  });
  it('refuses as retryable — never passes on the old customer\'s credit — when the receipt moved to another customer', async () => {
    const err = await inJudgedCall(judgedDays, 50, 'other').catch((e: unknown) => e);
    expect(isRetryableReceiptRefusal(err)).toBe(true);
    expect(tryLockCustomerCredit).not.toHaveBeenCalled(); // the stale customer is neither locked nor read
    expect(customerCreditDays).toHaveBeenCalledTimes(1); // only the judgment's read
  });
  it('refuses as retryable when ANOTHER row of the judged set moved to another customer', async () => {
    expect(isRetryableReceiptRefusal(await inJudgedCall(judgedDays, 50, 'c', 'other').catch((e: unknown) => e))).toBe(true);
  });
  it('refuses as retryable when a judged receipt\'s remainder moved', async () => {
    expect(isRetryableReceiptRefusal(await inJudgedCall(judgedDays, 80).catch((e: unknown) => e))).toBe(true);
  });
});

describe('withReceiptCancellationsJudged — N receipts of one customer read its credit once', () => {
  it('the judgment, then ONE verification for the customer; each later receipt checks only its own row', async () => {
    const ids = ['a', 'b', 'c'];
    const judgedDays = [day('2026-05-02', 300, 300, 0), day('2026-05-09', 100)];
    // reads in order: the judgment's rows, a's own row, the set (once, at a), b's own row, c's own row
    sqlMock
      .mockResolvedValueOnce(rows(['a', 'c', 100], ['b', 'c', 100], ['c', 'c', 100]))
      .mockResolvedValueOnce(rows(['a', 'c', 100]))
      .mockResolvedValueOnce(rows(['a', 'c', 100], ['b', 'c', 100], ['c', 'c', 100]))
      .mockResolvedValueOnce(rows(['b', 'c', 100]))
      .mockResolvedValueOnce(rows(['c', 'c', 100]));
    vi.mocked(customerCreditDays).mockResolvedValue({ customerName: 'Acme', days: judgedDays });
    vi.mocked(tryLockCustomerCredit).mockResolvedValueOnce('acquired').mockResolvedValue('held');
    await withReceiptCancellationsJudged('co', ids, async () => {
      for (const id of ids) await assertReceiptVoidKeepsCredit('co', [id]);
    });
    expect(customerCreditDays).toHaveBeenCalledTimes(2); // judgment + one verification, not one per receipt
    expect(tryLockCustomerCredit).toHaveBeenCalledTimes(3); // re-taken (re-entrant) at every receipt: still held?
  });
  it('a verification made under a lock that has since LAPSED is made again (a rolled-back savepoint released it)', async () => {
    sqlMock
      .mockResolvedValueOnce(rows(['a', 'c', 100], ['b', 'c', 100])) // the judgment's rows
      .mockResolvedValueOnce(rows(['a', 'c', 100])) // a's own row
      .mockResolvedValueOnce(rows(['a', 'c', 100], ['b', 'c', 100])) // the set, at a
      .mockResolvedValueOnce(rows(['b', 'c', 100])) // b's own row
      .mockResolvedValueOnce(rows(['a', 'c', 100], ['b', 'c', 100])); // the set again, at b
    const judgedDays = [day('2026-05-20', 200, 200, 0), day('2026-05-25', 0, 0, 0)];
    vi.mocked(customerCreditDays)
      .mockResolvedValueOnce({ customerName: 'Acme', days: judgedDays }) // the judgment
      .mockResolvedValueOnce({ customerName: 'Acme', days: judgedDays }) // a's verification
      .mockResolvedValueOnce({ customerName: 'Acme', days: [...judgedDays.slice(0, 1), day('2026-05-25', -50)] }); // b's: a refund landed
    vi.mocked(tryLockCustomerCredit).mockResolvedValueOnce('acquired').mockResolvedValueOnce('acquired');
    const err = await withReceiptCancellationsJudged('co', ['a', 'b'], async () => {
      await assertReceiptVoidKeepsCredit('co', ['a']);
      await assertReceiptVoidKeepsCredit('co', ['b']);
    }).catch((e: unknown) => e);
    expect(isRetryableReceiptRefusal(err)).toBe(true);
    expect(customerCreditDays).toHaveBeenCalledTimes(3);
  });
  it('a later receipt whose own remainder moved after the customer was verified is still refused, retryable', async () => {
    sqlMock
      .mockResolvedValueOnce(rows(['a', 'c', 100], ['b', 'c', 100]))
      .mockResolvedValueOnce(rows(['a', 'c', 100]))
      .mockResolvedValueOnce(rows(['a', 'c', 100], ['b', 'c', 100]))
      .mockResolvedValueOnce(rows(['b', 'c', 160])); // unapplied since (an unapply takes no customer lock)
    vi.mocked(customerCreditDays).mockResolvedValue({ customerName: 'Acme', days: [day('2026-05-02', 200, 200, 0)] });
    const err = await withReceiptCancellationsJudged('co', ['a', 'b'], async () => {
      await assertReceiptVoidKeepsCredit('co', ['a']);
      await assertReceiptVoidKeepsCredit('co', ['b']);
    }).catch((e: unknown) => e);
    expect(isRetryableReceiptRefusal(err)).toBe(true);
  });
});

describe('customerCreditFall — a write judged on the rows it left', () => {
  it('a date the write lowered that ends below zero is a fall; one it raised or left alone is not', async () => {
    // before: 06-14 400, 06-22 -350 (cum 50); after: the receipt keeps 100 → 06-14 100, 06-22 cum -250
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day('2026-06-14', 100), day('2026-06-22', -350)] });
    expect(await customerCreditFall('co', 'c', [day('2026-06-14', 400), day('2026-06-22', -350)]))
      .toEqual({ customerId: 'c', customerName: 'Acme', lowers: 300, credit: 50, fromDate: '2026-06-14' });
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day('2026-06-14', 1000), day('2026-06-22', -350)] });
    expect(await customerCreditFall('co', 'c', [day('2026-06-14', 400), day('2026-06-22', -350)])).toBeNull();
  });
  it('a customer already below zero is not "fallen" by a write that left its dates where they were', async () => {
    vi.mocked(customerCreditDays).mockResolvedValueOnce({ customerName: 'Acme', days: [day('2026-06-01', -100)] });
    expect(await customerCreditFall('co', 'c', [day('2026-06-01', -100)])).toBeNull();
  });
});
