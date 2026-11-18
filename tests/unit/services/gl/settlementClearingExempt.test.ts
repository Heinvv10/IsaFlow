/**
 * VR (coordinator ruling): the only journal exempt from a VAT lock is the settlement's clearing journal, on the first
 * day of the lock, settling a finalised period that ends the day before. `q` is a stub; on real PG:
 * tests/integration/vat-returns-settlement-next-lock.int.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { settlementClearingExempt } from '@/modules/accounting/services/gl/journalVatLockGuard';

const CO = '00000000-0000-0000-0000-000000000001';
const LOCK = { id: 'l', periodStart: '2026-09-01', periodEnd: '2026-10-31' };
const stub = (rows: unknown[]) => vi.fn(async () => rows);
const text = (q: ReturnType<typeof stub>) => ((q.mock.calls[0] as unknown[])[0] as string[]).join('?');

describe('settlementClearingExempt', () => {
  it('the clearing journal on the lock\'s first day, the period before finalised: exempt', async () => {
    const q = stub([{ '?column?': 1 }]);
    expect(await settlementClearingExempt(CO, '2026-09-01', LOCK, 'auto_vat_submission', q)).toBe(true);
    expect(text(q)).toMatch(/form_type = 'VAT201' AND status IN \('finalised', 'filed'\)/);
    expect(text(q)).toMatch(/period_end = \?::DATE - 1/);
    expect((q.mock.calls[0] as unknown[]).slice(1)).toEqual([CO, '2026-09-01']);
  });

  it('no finalised or filed VAT201 ending the day before: not exempt', async () => {
    expect(await settlementClearingExempt(CO, '2026-09-01', LOCK, 'auto_vat_submission', stub([]))).toBe(false);
  });

  it.each(['manual', 'auto_vat_adjustment', null, undefined])('source %s: not exempt, and nothing is read', async (src) => {
    const q = stub([{ x: 1 }]);
    expect(await settlementClearingExempt(CO, '2026-09-01', LOCK, src, q)).toBe(false);
    expect(q).not.toHaveBeenCalled();
  });

  it('any other day inside the lock: not exempt', async () => {
    const q = stub([{ x: 1 }]);
    expect(await settlementClearingExempt(CO, '2026-09-02', LOCK, 'auto_vat_submission', q)).toBe(false);
    expect(q).not.toHaveBeenCalled();
  });
});
