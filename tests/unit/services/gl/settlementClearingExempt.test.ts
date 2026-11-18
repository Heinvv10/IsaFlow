/**
 * VR (coordinator ruling; round-2 L2): the only journal exempt from a VAT lock is the settlement's clearing journal, on
 * the first day of the lock, settling a finalised period that ends the day before, whose lines are a clearing: no
 * vat_type, every line on a VAT control or net-VAT account. `q` is a stub; on real PG:
 * tests/integration/vat-returns-settlement-next-lock.int.test.ts and vat-returns-settlement-round2.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccountId: vi.fn() }));

import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { settlementClearingExempt } from '@/modules/accounting/services/gl/journalVatLockGuard';

const CO = '00000000-0000-0000-0000-000000000001';
const LOCK = { id: 'l', periodStart: '2026-09-01', periodEnd: '2026-10-31' };
const OUT = { id: 'a-out', account_code: '2120', account_subtype: 'vat_output' };
const INP = { id: 'a-in', account_code: '1140', account_subtype: 'vat_input' };
const NET = { id: 'a-net', account_code: '2130', account_subtype: null };
const PAY = { id: 'a-pay', account_code: '2110', account_subtype: 'payable' };
const REV = { id: 'a-rev', account_code: '6000', account_subtype: 'revenue' };
const CLEARING = [{ glAccountId: 'a-out' }, { glAccountId: 'a-in' }, { glAccountId: 'a-net' }];
/** Reads in order: the finalised period before; the lines' accounts; the active 2130 (none = the payable fallback). */
const stub = (finalised: boolean, accounts: unknown[] = [OUT, INP, NET], active2130: unknown[] = [{ id: 'a-net' }]) =>
  vi.fn().mockResolvedValueOnce(finalised ? [{ x: 1 }] : []).mockResolvedValueOnce(accounts)
    .mockResolvedValueOnce(active2130);
const text = (q: ReturnType<typeof stub>, i = 0) => ((q.mock.calls[i] as unknown[])[0] as string[]).join('?');
const run = (q: ReturnType<typeof stub>, over: { date?: string; source?: string | null; lines?: unknown[] } = {}) =>
  settlementClearingExempt(CO, over.date ?? '2026-09-01', LOCK, over.source === undefined ? 'auto_vat_submission' : over.source,
    (over.lines ?? CLEARING) as never, q);

describe('settlementClearingExempt', () => {
  beforeEach(() => { vi.mocked(getSystemAccountId).mockReset(); vi.mocked(getSystemAccountId).mockResolvedValue('a-pay'); });

  it('the clearing journal on the lock\'s first day, the period before finalised, clearing lines: exempt', async () => {
    const q = stub(true);
    expect(await run(q)).toBe(true);
    expect(text(q)).toMatch(/form_type = 'VAT201' AND status IN \('finalised', 'filed'\)/);
    expect(text(q)).toMatch(/period_end = \?::DATE - 1/);
    expect((q.mock.calls[0] as unknown[]).slice(1)).toEqual([CO, '2026-09-01']);
  });

  it('no active 2130: the system payable account (the settlement\'s fallback) is the net-VAT account: exempt', async () => {
    const q = stub(true, [OUT, INP, PAY], []);
    expect(await run(q, { lines: [{ glAccountId: 'a-out' }, { glAccountId: 'a-in' }, { glAccountId: 'a-pay' }] })).toBe(true);
    expect(text(q, 2)).toMatch(/account_code = '2130' AND is_active = true/);
    expect(vi.mocked(getSystemAccountId)).toHaveBeenCalledWith('payable', CO);
  });

  it('an active 2130 exists: a payables line is NOT the net-VAT account (round 3, T9): not exempt', async () => {
    expect(await run(stub(true, [PAY, INP]), { lines: [{ glAccountId: 'a-pay' }, { glAccountId: 'a-in' }] })).toBe(false);
    expect(vi.mocked(getSystemAccountId)).not.toHaveBeenCalled();
  });

  it('no 2130 and a payables account that is not THE system payable account: not exempt', async () => {
    const other = { id: 'a-pay2', account_code: '2105', account_subtype: 'payable' };
    expect(await run(stub(true, [other, INP], []), { lines: [{ glAccountId: 'a-pay2' }, { glAccountId: 'a-in' }] })).toBe(false);
  });

  it('no 2130 and no system payable account: not exempt (the settlement would refuse anyway)', async () => {
    vi.mocked(getSystemAccountId).mockRejectedValue(new MissingSystemAccountError('payable' as never, CO, 'no_claimant' as never, []));
    expect(await run(stub(true, [OUT, PAY], []), { lines: [{ glAccountId: 'a-out' }, { glAccountId: 'a-pay' }] })).toBe(false);
  });

  it('only VAT control lines: exempt without resolving the net-VAT account', async () => {
    const q = stub(true, [OUT, INP]);
    expect(await run(q, { lines: [{ glAccountId: 'a-out' }, { glAccountId: 'a-in' }] })).toBe(true);
    expect(q).toHaveBeenCalledTimes(2);
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
