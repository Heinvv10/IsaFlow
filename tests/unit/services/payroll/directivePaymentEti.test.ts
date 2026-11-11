/**
 * A stand-alone directive payment books its month's ETI (wave 5 ET; coordinator ruling H2 option a; Hein rulings R-A,
 * R-C). ETI Act s9(1), s10(1); SARS Guide to the Employment Tax Incentive, Issue 5, §6.1 p. 42, §7-§8.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => [{ id: `acc-${String(v[1])}` }]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/etiCarryRead', () => ({ etiMonthLine: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/etiBooking', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/etiBooking')>()),
  bookedByEtiJournals: vi.fn(async () => ({ used: 0, refund: 0 })),
  bookedByRunJournal: vi.fn(async () => ({ used: 0, refund: 0 })),
}));
vi.mock('@/modules/accounting/services/payroll/etiPeriodGuard', () => ({
  assertNoLaterEtiJournal: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalEti', () => ({
  refundReceivable: vi.fn(async () => ({ id: 'acc-1150', accountCode: '1150', accountName: 'ETI refund receivable (SARS)' })),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ createJournalEntry: vi.fn(async () => ({ id: 'je-eti' })) }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/payroll/taxDirectivePaymentService', () => ({
  applyTaxDirective: vi.fn(async () => ({ paymentId: 'p1', journalEntryId: 'je-d', gross: 4_500, paye: 1_500, net: 3_000, status: 'applied', advisories: [] })),
}));

import { etiMonthLine } from '@/modules/accounting/services/payroll/etiCarryRead';
import { bookedByEtiJournals, bookedByRunJournal } from '@/modules/accounting/services/payroll/etiBooking';
import { assertNoLaterEtiJournal } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { applyTaxDirective as applyPayment } from '@/modules/accounting/services/payroll/taxDirectivePaymentService';
import { applyTaxDirective, directiveEtiLines } from '@/modules/accounting/services/payroll/directivePaymentEti';

const CO = '11111111-1111-1111-1111-111111111111';
const month = (over: Record<string, number>) => ({
  year: 2026, month: 5, paye: 1_500, eti: 0, broughtForward: 1_800, available: 1_800, used: 1_500, carriedForward: 300, refundClaimable: 0, ...over,
});
const sum = (lines: Array<{ glAccountId: string; debit: number; credit: number }>, id: string) =>
  lines.filter((l) => l.glAccountId === id).reduce((t, l) => t + l.debit - l.credit, 0);

beforeEach(() => vi.clearAllMocks());

describe('the month\'s ETI lines', () => {
  it('ledger-breaker B: a directive-only May uses R1 500 of April\'s carry; its ETI journal books it (DR 2140 / CR 5200)', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({}) as never);
    const lines = await directiveEtiLines(CO, { year: 2026, month: 5 });
    expect(sum(lines, 'acc-2140')).toBe(1_500);
    expect(sum(lines, 'acc-5200')).toBe(-1_500);
  });
  it('books only what the run\'s journal and earlier ETI journals have not (one month, one total)', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ used: 2_300 }) as never);
    vi.mocked(bookedByRunJournal).mockResolvedValueOnce({ used: 1_000, refund: 0 });
    vi.mocked(bookedByEtiJournals).mockResolvedValueOnce({ used: 500, refund: 0 });
    expect(sum(await directiveEtiLines(CO, { year: 2026, month: 6 }), 'acc-2140')).toBe(800);
  });
  it('R-C: in August it also books the unused ETI as the refund (DR receivable / CR 5200)', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ month: 8, used: 1_500, refundClaimable: 300 }) as never);
    const lines = await directiveEtiLines(CO, { year: 2026, month: 8 });
    expect(sum(lines, 'acc-1150')).toBe(300);
    expect(sum(lines, 'acc-5200')).toBe(-1_800);
  });
  it('nothing left to book: no lines', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ used: 1_500 }) as never);
    vi.mocked(bookedByEtiJournals).mockResolvedValueOnce({ used: 1_500, refund: 0 });
    expect(await directiveEtiLines(CO, { year: 2026, month: 5 })).toEqual([]);
  });
});

describe('applyTaxDirective with ETI', () => {
  it('R-A: refused before the payment when a later month of the ETI period is posted', async () => {
    vi.mocked(assertNoLaterEtiJournal).mockRejectedValueOnce(new Error('The June 2026 payroll journal is already posted'));
    await expect(applyTaxDirective(CO, 'd1', { paymentDate: '2026-05-20' }, 'u1')).rejects.toThrow(/June 2026/);
    expect(applyPayment).not.toHaveBeenCalled();
    expect(assertNoLaterEtiJournal).toHaveBeenCalledWith(CO, { year: 2026, month: 5 });
  });
  it('posts the payment, then the month\'s ETI journal (reference ETI-2026-05, source auto_payroll, dated with the payment)', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({}) as never);
    const r = await applyTaxDirective(CO, 'd1', { paymentDate: '2026-05-20' }, 'u1');
    expect(r.etiJournalEntryId).toBe('je-eti');
    expect(vi.mocked(createJournalEntry).mock.calls[0]![1]).toMatchObject({ entryDate: '2026-05-20', reference: 'ETI-2026-05', source: 'auto_payroll' });
  });
});
