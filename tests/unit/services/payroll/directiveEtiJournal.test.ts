/**
 * The month's ETI journal (wave 5 ET; coordinator ruling H2 option a; Hein ruling R-C; review round 2 M2/M3).
 * ETI Act s9(1), s10(1); SARS Guide to the Employment Tax Incentive, Issue 5, §6.1 p. 42, §7-§8.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/etiCarryRead', () => ({ etiMonthLine: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/etiBooking', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/etiBooking')>()),
  bookedByEtiJournals: vi.fn(async () => ({ used: 0, refund: 0 })),
  bookedByRunJournal: vi.fn(async () => ({ used: 0, refund: 0, net2140: 0 })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalEti', () => ({
  refundReceivable: vi.fn(async () => ({ id: 'acc-1150', accountCode: '1150', accountName: 'ETI refund receivable (SARS)' })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalParts', () => ({
  resolveAccounts: vi.fn(async () => new Map([['2140', { id: 'acc-2140', name: 'PAYE', isActive: true }], ['5200', { id: 'acc-5200', name: 'Labour', isActive: true }]])),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({ payrollJournalInForce: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ createJournalEntry: vi.fn(async () => ({ id: 'je-eti' })) }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostService', () => ({ postJournalEntry: vi.fn(async () => undefined) }));

import { etiMonthLine } from '@/modules/accounting/services/payroll/etiCarryRead';
import { bookedByEtiJournals, bookedByRunJournal } from '@/modules/accounting/services/payroll/etiBooking';
import { refundReceivable } from '@/modules/accounting/services/payroll/payrollJournalEti';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import {
  directiveEtiLines, etiMonthPlan, postMonthEtiJournal,
} from '@/modules/accounting/services/payroll/directiveEtiJournal';

const CO = '11111111-1111-1111-1111-111111111111';
const month = (over: Record<string, number>) => ({
  year: 2026, month: 5, paye: 1_500, eti: 0, broughtForward: 1_800, available: 1_800, used: 1_500, carriedForward: 300, refundClaimable: 0, ...over,
});
const sum = (lines: Array<{ glAccountId: string; debit: number; credit: number }>, id: string) =>
  lines.filter((l) => l.glAccountId === id).reduce((t, l) => t + l.debit - l.credit, 0);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing to book (a month with no ETI, nothing booked).
  vi.mocked(etiMonthLine).mockImplementation(async (_c, ym) => ({ ...ym, paye: 0, eti: 0, broughtForward: 0, available: 0, used: 0, carriedForward: 0, refundClaimable: 0 }));
  vi.mocked(bookedByEtiJournals).mockImplementation(async () => ({ used: 0, refund: 0 }));
  vi.mocked(bookedByRunJournal).mockImplementation(async () => ({ used: 0, refund: 0, net2140: 0 }));
  vi.mocked(sql).mockImplementation((async () => []) as never);
});

describe('the month\'s ETI lines', () => {
  it('ledger-breaker B: a directive-only May uses R1 500 of April\'s carry; its ETI journal books it (DR 2140 / CR 5200)', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({}) as never);
    const lines = await directiveEtiLines(CO, { year: 2026, month: 5 });
    expect(sum(lines, 'acc-2140')).toBe(1_500);
    expect(sum(lines, 'acc-5200')).toBe(-1_500);
    expect(refundReceivable).not.toHaveBeenCalled(); // no refund due: the role is not read
  });
  it('books only what the run\'s journal and earlier ETI journals have not (one month, one total)', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ used: 2_300 }) as never);
    vi.mocked(bookedByRunJournal).mockResolvedValueOnce({ used: 1_000, refund: 0, net2140: 2_000 });
    vi.mocked(bookedByEtiJournals).mockResolvedValueOnce({ used: 500, refund: 0 });
    expect(sum(await directiveEtiLines(CO, { year: 2026, month: 6 }), 'acc-2140')).toBe(800);
  });
  it('review M2: August with R500 of the refund booked and R1 500 claimable books the other R1 000', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ month: 8, used: 1_500, refundClaimable: 1_500 }) as never);
    vi.mocked(bookedByEtiJournals).mockResolvedValueOnce({ used: 1_500, refund: 500 });
    const lines = await directiveEtiLines(CO, { year: 2026, month: 8 });
    expect(sum(lines, 'acc-1150')).toBe(1_000);
    expect(sum(lines, 'acc-2140')).toBe(0);
    expect(sum(lines, 'acc-5200')).toBe(-1_000);
  });
  it('review M2: everything booked (refund booked = claimable): no lines, and no refund role read', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ month: 8, used: 1_500, refundClaimable: 1_500 }) as never);
    vi.mocked(bookedByEtiJournals).mockResolvedValueOnce({ used: 1_500, refund: 1_500 });
    expect(await directiveEtiLines(CO, { year: 2026, month: 8 })).toEqual([]);
    expect(refundReceivable).not.toHaveBeenCalled();
  });
  it('round 5 adv L1: a refund due with no account holding the role is left out of the plan (lines AND amounts), the same for post and preview', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ month: 8, used: 0, refundClaimable: 900 }) as never);
    vi.mocked(bookedByEtiJournals).mockResolvedValueOnce({ used: 0, refund: 0 });
    vi.mocked(refundReceivable).mockResolvedValueOnce(null as never);
    expect(await etiMonthPlan(CO, { year: 2026, month: 8 })).toEqual({ lines: [], used: 0, refund: 0 });
  });
  it('round 5 adv L1: the plan says what its lines book (used on 2140, refund on the receivable)', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ month: 8, used: 1_500, refundClaimable: 900 }) as never);
    const plan = await etiMonthPlan(CO, { year: 2026, month: 8 });
    expect([plan.used, plan.refund]).toEqual([1_500, 900]);
    expect([sum(plan.lines, 'acc-2140'), sum(plan.lines, 'acc-1150')]).toEqual([1_500, 900]);
  });
  it('posts the journal with reference ETI-2026-05 and source auto_payroll, dated as given', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({}) as never);
    expect(await postMonthEtiJournal(CO, { year: 2026, month: 5 }, '2026-05-20', 'u1')).toBe('je-eti');
    expect(vi.mocked(createJournalEntry).mock.calls[0]![1]).toMatchObject({ entryDate: '2026-05-20', reference: 'ETI-2026-05', source: 'auto_payroll' });
  });
});

describe('the month\'s ETI lines: a refund the run journal booked is not booked again (tdd3 M2)', () => {
  it('August: R1 500 claimable, the run journal booked R500 of it: the ETI journal books R1 000', async () => {
    vi.mocked(etiMonthLine).mockResolvedValueOnce(month({ month: 8, used: 1_500, refundClaimable: 1_500 }) as never);
    vi.mocked(bookedByRunJournal).mockResolvedValueOnce({ used: 1_500, refund: 500, net2140: 0 });
    const lines = await directiveEtiLines(CO, { year: 2026, month: 8 });
    expect(sum(lines, 'acc-1150')).toBe(1_000);
    expect(sum(lines, 'acc-2140')).toBe(0);
  });
});
