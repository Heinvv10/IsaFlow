/**
 * VR (coordinator ruling; round-2 L2): the only journal exempt from a VAT lock is the settlement's clearing journal, on
 * the first day of the lock, settling a finalised period that ends the day before, whose lines are a clearing: no
 * vat_type, every line on a VAT control or net-VAT account. `q` is a stub; on real PG:
 * tests/integration/vat-returns-settlement-next-lock.int.test.ts and vat-returns-settlement-round2.int.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { settlementClearingExempt } from '@/modules/accounting/services/gl/journalVatLockGuard';

const CO = '00000000-0000-0000-0000-000000000001';
const LOCK = { id: 'l', periodStart: '2026-09-01', periodEnd: '2026-10-31' };
const OUT = { id: 'a-out', account_code: '2120', account_subtype: 'vat_output' };
const INP = { id: 'a-in', account_code: '1140', account_subtype: 'vat_input' };
const NET = { id: 'a-net', account_code: '2130', account_subtype: null };
const PAY = { id: 'a-pay', account_code: '2110', account_subtype: 'payable' };
const REV = { id: 'a-rev', account_code: '6000', account_subtype: 'revenue' };
const CLEARING = [{ glAccountId: 'a-out' }, { glAccountId: 'a-in' }, { glAccountId: 'a-net' }];
/** First read: the finalised period before; second: the lines' accounts. */
const stub = (finalised: boolean, accounts: unknown[] = [OUT, INP, NET]) =>
  vi.fn().mockResolvedValueOnce(finalised ? [{ x: 1 }] : []).mockResolvedValueOnce(accounts);
const text = (q: ReturnType<typeof stub>, i = 0) => ((q.mock.calls[i] as unknown[])[0] as string[]).join('?');
const run = (q: ReturnType<typeof stub>, over: { date?: string; source?: string | null; lines?: unknown[] } = {}) =>
  settlementClearingExempt(CO, over.date ?? '2026-09-01', LOCK, over.source === undefined ? 'auto_vat_submission' : over.source,
    (over.lines ?? CLEARING) as never, q);

describe('settlementClearingExempt', () => {
  it('the clearing journal on the lock\'s first day, the period before finalised, clearing lines: exempt', async () => {
    const q = stub(true);
    expect(await run(q)).toBe(true);
    expect(text(q)).toMatch(/form_type = 'VAT201' AND status IN \('finalised', 'filed'\)/);
    expect(text(q)).toMatch(/period_end = \?::DATE - 1/);
    expect((q.mock.calls[0] as unknown[]).slice(1)).toEqual([CO, '2026-09-01']);
  });

  it('the payables fallback as the net-VAT account: exempt', async () => {
    expect(await run(stub(true, [OUT, INP, PAY]), { lines: [{ glAccountId: 'a-out' }, { glAccountId: 'a-in' }, { glAccountId: 'a-pay' }] })).toBe(true);
  });

  it('no finalised or filed VAT201 ending the day before: not exempt', async () => {
    expect(await run(stub(false))).toBe(false);
  });

  it.each(['manual', 'auto_vat_adjustment', null])('source %s: not exempt, and nothing is read', async (src) => {
    const q = stub(true);
    expect(await run(q, { source: src })).toBe(false);
    expect(q).not.toHaveBeenCalled();
  });

  it('any other day inside the lock: not exempt', async () => {
    const q = stub(true);
    expect(await run(q, { date: '2026-09-02' })).toBe(false);
    expect(q).not.toHaveBeenCalled();
  });

  it('a line carrying a vat_type (a supply, not a clearing): not exempt (round 2 L2)', async () => {
    const q = stub(true);
    expect(await run(q, { lines: [{ glAccountId: 'a-out', vatType: 'standard' }, { glAccountId: 'a-net' }] })).toBe(false);
    expect(q).not.toHaveBeenCalled();
  });

  it('a line on a revenue account (a sale dressed as a clearing): not exempt (round 2 L2)', async () => {
    const q = stub(true, [OUT, REV]);
    expect(await run(q, { lines: [{ glAccountId: 'a-out' }, { glAccountId: 'a-rev' }] })).toBe(false);
  });

  it('a line on an account the company does not hold: not exempt', async () => {
    expect(await run(stub(true, [OUT]), { lines: [{ glAccountId: 'a-out' }, { glAccountId: 'elsewhere' }] })).toBe(false);
  });
});
