/**
 * Integrity check paye_payable_differs_from_emp201 (wave 5 ET; Hein rulings R-A, R-C; review round 2 M2, M3, L1, L4):
 * the ledger's month 2140 and ETI refund, tied to the month by link and reference, against one ETI ledger of the EMP201.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/etiCarryRead', () => ({ loadEtiMonths: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/etiBooking', () => ({
  bookedByRunJournal: vi.fn(async () => ({ used: 0, refund: 0, net2140: 0 })),
  bookedByEtiJournals: vi.fn(async () => ({ used: 0, refund: 0 })),
}));
vi.mock('@/modules/accounting/services/payroll/directivePaymentFiling', () => ({ listStandaloneDirectivePayments: vi.fn(async () => []) }));

import { sql } from '@/lib/neon';
import { loadEtiMonths } from '@/modules/accounting/services/payroll/etiCarryRead';
import { bookedByEtiJournals, bookedByRunJournal } from '@/modules/accounting/services/payroll/etiBooking';
import { payePayableDiffersFromEmp201 } from '@/modules/accounting/services/gl/integrityChecks/payrollChecks';
import { INTEGRITY_CHECK_IDS } from '@/modules/accounting/services/gl/integrityChecks';

const CO = '11111111-1111-1111-1111-111111111111';
const ctx = (asAt: string) => ({ companyId: CO, asAt, limit: 20 });
const june = { year: 2026, month: 6 };
const isJune = (ym: { year: number; month: number }) => ym.year === 2026 && ym.month === 6;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bookedByRunJournal).mockImplementation(async () => ({ used: 0, refund: 0, net2140: 0 }));
  vi.mocked(bookedByEtiJournals).mockImplementation(async () => ({ used: 0, refund: 0 }));
});

describe('paye_payable_differs_from_emp201', () => {
  it('is in the suite', () => {
    expect(INTEGRITY_CHECK_IDS).toContain('paye_payable_differs_from_emp201');
  });
  it('flags a month whose 2140 (run journal by link + directives - ETI journals) differs from the EMP201 payable', async () => {
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ ...june, paye: 3_000, eti: 500 }]);
    vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 6, calculation_version: 9 }] as never);
    vi.mocked(bookedByRunJournal).mockImplementation(async (_c, ym) => (isJune(ym) ? { used: 500, refund: 0, net2140: 2_500 } : { used: 0, refund: 0, net2140: 0 }));
    const r = await payePayableDiffersFromEmp201(ctx('2026-06-30'));
    // EMP201: 3 000 - 500 = 2 500; booked 2 500: equal.
    expect(r.count).toBe(0);
    vi.mocked(bookedByEtiJournals).mockImplementation(async (_c, ym) => (isJune(ym) ? { used: 300, refund: 0 } : { used: 0, refund: 0 }));
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ ...june, paye: 3_000, eti: 500 }]);
    vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 6, calculation_version: 9 }] as never);
    const r2 = await payePayableDiffersFromEmp201(ctx('2026-06-30'));
    expect(r2.sample).toEqual([expect.objectContaining({ id: '2026-06', amount: -300 })]);
  });
  it('review M2: a month that has not ended by as_at is not judged (a run approved on the 25th)', async () => {
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ year: 2026, month: 11, paye: 3_000, eti: 0 }]);
    const r = await payePayableDiffersFromEmp201(ctx('2026-11-25'));
    expect(r.count).toBe(0);
    expect(vi.mocked(bookedByRunJournal).mock.calls.map((c) => c[1])).not.toContainEqual({ year: 2026, month: 11 });
  });
  it('review L1: a month calculated before ETI carry-forward (version < 9) is named in the finding, not counted', async () => {
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ ...june, paye: 3_000, eti: 500 }]);
    vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 6, calculation_version: 6 }] as never);
    vi.mocked(bookedByRunJournal).mockImplementation(async (_c, ym) => (isJune(ym) ? { used: 0, refund: 0, net2140: 3_000 } : { used: 0, refund: 0, net2140: 0 }));
    const r = await payePayableDiffersFromEmp201(ctx('2026-06-30'));
    expect(r.count).toBe(0);
    expect(r.finding).toContain('2026-06');
  });
  it('R-C / review L3: an August whose refund claimable was not booked (no journal to carry it) is reported', async () => {
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ year: 2026, month: 7, paye: 0, eti: 1_000 }]);
    const r = await payePayableDiffersFromEmp201(ctx('2026-08-31'));
    expect(r.sample).toEqual([expect.objectContaining({ id: '2026-08-refund', amount: -1_000 })]);
    expect(r.sample[0]!.detail).toMatch(/no payroll journal posted in the month/);
  });
  it("review L4: one ETI ledger read for the twelve months, from the start of the first month's period", async () => {
    await payePayableDiffersFromEmp201(ctx('2026-08-31'));
    expect(loadEtiMonths).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadEtiMonths).mock.calls[0]!.slice(1)).toEqual([{ year: 2025, month: 9 }, { year: 2026, month: 8 }]);
  });
});
