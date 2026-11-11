/**
 * Integrity check paye_payable_differs_from_emp201 (wave 5 ET; Hein rulings R-A, R-C; review round 2 M2, M3, L1, L4):
 * the ledger's month 2140 and ETI refund, tied to the month by link and reference, against one ETI ledger of the EMP201.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/etiCarryRead', () => ({ loadEtiMonths: vi.fn(async () => []) }));
// The single-month mocks below are fanned out over the batch reads the check makes (rev3 L2).
const runOf = vi.hoisted(() => ({ fn: async (_ym: { year: number; month: number }): Promise<unknown> => ({ used: 0, refund: 0, net2140: 0 }) }));
const etiOf = vi.hoisted(() => ({ fn: async (_ym: { year: number; month: number }): Promise<unknown> => ({ used: 0, refund: 0 }) }));
vi.mock('@/modules/accounting/services/payroll/etiBooking', () => {
  const key = (ym: { year: number; month: number }) => `${ym.year}-${String(ym.month).padStart(2, '0')}`;
  return {
    monthKey: key,
    bookedRunJournalsByMonth: vi.fn(async (_c: string, months: Array<{ year: number; month: number }>) => new Map(await Promise.all(months.map(async (m) => [key(m), await runOf.fn(m)] as const)))),
    bookedEtiJournalsByMonth: vi.fn(async (_c: string, months: Array<{ year: number; month: number }>) => new Map(await Promise.all(months.map(async (m) => [key(m), await etiOf.fn(m)] as const)))),
  };
});
vi.mock('@/modules/accounting/services/payroll/directivePaymentFiling', () => ({ listStandaloneDirectivePayments: vi.fn(async () => []) }));

import { sql } from '@/lib/neon';
import { loadEtiMonths } from '@/modules/accounting/services/payroll/etiCarryRead';
import { bookedEtiJournalsByMonth, bookedRunJournalsByMonth } from '@/modules/accounting/services/payroll/etiBooking';
import { listStandaloneDirectivePayments } from '@/modules/accounting/services/payroll/directivePaymentFiling';
const bookedByRunJournal = { mockImplementation: (f: (c: string, ym: { year: number; month: number }) => Promise<unknown>) => { runOf.fn = (ym) => f('', ym); } };
const bookedByEtiJournals = { mockImplementation: (f: (c: string, ym: { year: number; month: number }) => Promise<unknown>) => { etiOf.fn = (ym) => f('', ym); } };
import { payePayableDiffersFromEmp201 } from '@/modules/accounting/services/gl/integrityChecks/payrollChecks';
import { INTEGRITY_CHECK_IDS } from '@/modules/accounting/services/gl/integrityChecks';

const CO = '11111111-1111-1111-1111-111111111111';
const ctx = (asAt: string) => ({ companyId: CO, asAt, limit: 20 });
const june = { year: 2026, month: 6 };
const isJune = (ym: { year: number; month: number }) => ym.year === 2026 && ym.month === 6;

beforeEach(() => {
  vi.clearAllMocks();
  bookedByRunJournal.mockImplementation(async () => ({ used: 0, refund: 0, net2140: 0 }));
  bookedByEtiJournals.mockImplementation(async () => ({ used: 0, refund: 0 }));
});

describe('paye_payable_differs_from_emp201', () => {
  it('is in the suite', () => {
    expect(INTEGRITY_CHECK_IDS).toContain('paye_payable_differs_from_emp201');
  });
  it('flags a month whose 2140 (run journal by link + directives - ETI journals) differs from the EMP201 payable', async () => {
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ ...june, paye: 3_000, eti: 500 }]);
    vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 6, calculation_version: 8 }] as never);
    bookedByRunJournal.mockImplementation(async (_c, ym) => (isJune(ym) ? { used: 500, refund: 0, net2140: 2_500 } : { used: 0, refund: 0, net2140: 0 }));
    const r = await payePayableDiffersFromEmp201(ctx('2026-06-30'));
    // EMP201: 3 000 - 500 = 2 500; booked 2 500: equal.
    expect(r.count).toBe(0);
    bookedByEtiJournals.mockImplementation(async (_c, ym) => (isJune(ym) ? { used: 300, refund: 0 } : { used: 0, refund: 0 }));
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ ...june, paye: 3_000, eti: 500 }]);
    vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 6, calculation_version: 8 }] as never);
    const r2 = await payePayableDiffersFromEmp201(ctx('2026-06-30'));
    expect(r2.sample).toEqual([expect.objectContaining({ id: '2026-06', amount: -300 })]);
  });
  it('review M2: a month that has not ended by as_at is not judged (a run approved on the 25th)', async () => {
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ year: 2026, month: 11, paye: 3_000, eti: 0 }]);
    const r = await payePayableDiffersFromEmp201(ctx('2026-11-25'));
    expect(r.count).toBe(0);
    expect(vi.mocked(bookedRunJournalsByMonth).mock.calls[0]![1]).not.toContainEqual({ year: 2026, month: 11 });
  });
  it('review L1: a month calculated before ETI carry-forward (version < 8) is named in the finding, not counted', async () => {
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ ...june, paye: 3_000, eti: 500 }]);
    vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 6, calculation_version: 6 }] as never);
    bookedByRunJournal.mockImplementation(async (_c, ym) => (isJune(ym) ? { used: 0, refund: 0, net2140: 3_000 } : { used: 0, refund: 0, net2140: 0 }));
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
  it('coordinator (b): the finding says how a hand-reversed ETI journal is rebooked', async () => {
    const r = await payePayableDiffersFromEmp201(ctx('2026-06-30'));
    expect(r.finding).toMatch(/reversed by hand is not rebooked automatically: the month is rebooked by the next approval, reopen, or directive payment or reversal/);
  });
  it('rev3 L2: one batch read each for runs, ETI journals and directives, whatever the number of months', async () => {
    await payePayableDiffersFromEmp201(ctx('2026-08-31'));
    expect(bookedRunJournalsByMonth).toHaveBeenCalledTimes(1);
    expect(bookedEtiJournalsByMonth).toHaveBeenCalledTimes(1);
    expect(listStandaloneDirectivePayments).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bookedRunJournalsByMonth).mock.calls[0]![1]).toHaveLength(12);
  });
  it('adv3 L3: a month with negative PAYE (a refund through payroll) compares unfloored: 2140 -300 = EMP201 -300, green', async () => {
    vi.mocked(loadEtiMonths).mockResolvedValueOnce([{ ...june, paye: -300, eti: 0 }]);
    vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 6, calculation_version: 8 }] as never);
    bookedByRunJournal.mockImplementation(async (_c, ym) => (isJune(ym) ? { used: 0, refund: 0, net2140: -300 } : { used: 0, refund: 0, net2140: 0 }));
    expect((await payePayableDiffersFromEmp201(ctx('2026-06-30'))).count).toBe(0);
  });
});
