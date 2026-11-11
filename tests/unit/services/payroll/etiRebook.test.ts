/**
 * Rebooking run-less months (wave 5 ET; coordinator rulings, review rounds 3 and 4: M1 (a)-(d), M2 dating).
 * ETI Act s9(1), s10(1); SARS Guide to the Employment Tax Incentive, Issue 5, §7-§8.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/directiveEtiJournal', () => ({
  postMonthEtiJournal: vi.fn(async () => 'je-eti'),
  etiDueForMonth: vi.fn(async () => ({ used: 0, refund: 0 })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({ payrollJournalInForce: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/payroll/etiPeriodGuard', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/etiPeriodGuard')>()),
  periodHasEti: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockCompanyPayrollApprovals: vi.fn(async () => undefined) }));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { etiDueForMonth, postMonthEtiJournal } from '@/modules/accounting/services/payroll/directiveEtiJournal';
import { periodHasEti } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { lockCompanyPayrollApprovals } from '@/modules/accounting/services/payroll/payrollRunLock';
import {
  bookEtiAfterDirectiveReversal, bookEtiForMonth, bookEtiForMonthLocked, etiRebookDate, previewEtiForMonth, rebookEtiAfterEvent,
} from '@/modules/accounting/services/payroll/etiRebook';

const CO = '11111111-1111-1111-1111-111111111111';
/** Months (y*100+m) whose run journal is in force; months whose fiscal period is closed; the first open date after them. */
let inForce = new Set<number>();
let closed = new Set<string>();
let firstOpen: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  inForce = new Set(); closed = new Set(); firstOpen = null;
  vi.mocked(postMonthEtiJournal).mockImplementation(async () => 'je-eti');
  vi.mocked(periodHasEti).mockImplementation(async () => true);
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join('?');
    if (q.includes('payroll_run_headers')) return inForce.has(Number(v[1]) * 100 + Number(v[2])) ? [{ journal_entry_id: 'je-run' }] : [];
    if (q.includes("status = 'open'")) return firstOpen ? [{ d: firstOpen }] : [];
    if (q.includes('fiscal_periods')) return closed.has(String(v[1])) ? [{ status: 'closed' }] : [{ status: 'open' }];
    return [];
  }) as never);
});
afterEach(() => { vi.useRealTimers(); });

const postedMonths = () => vi.mocked(postMonthEtiJournal).mock.calls.map((c) => `${c[1].year}-${String(c[1].month).padStart(2, '0')}@${c[2]}`);

describe('rebookEtiAfterEvent (round 4 M1 (a)/(b)): every run-less month of this and the previous half-year that has ended', () => {
  it('adv Repro A: a September trigger books the whole earlier half-year (August\'s refund) and September, the trigger month; July (run in force) and November (not ended) are left', async () => {
    inForce = new Set([202607]);
    await rebookEtiAfterEvent(CO, { year: 2026, month: 9 }, 'u1', '2026-11-12');
    expect(postedMonths()).toEqual([
      '2026-03@2026-03-31', '2026-04@2026-04-30', '2026-05@2026-05-31', '2026-06@2026-06-30', '2026-08@2026-08-31',
      '2026-09@2026-09-30', '2026-10@2026-10-31',
    ]);
  });
  it('the trigger month and EARLIER months of its half-year are rebooked, not only later ones (a June trigger rebooks April)', async () => {
    vi.mocked(periodHasEti).mockImplementation(async (_c, ym) => ym.month === 3);
    await rebookEtiAfterEvent(CO, { year: 2026, month: 6 }, 'u1', '2026-07-05');
    expect(postedMonths()).toEqual(['2026-03@2026-03-31', '2026-04@2026-04-30', '2026-05@2026-05-31', '2026-06@2026-06-30']);
  });
  it('a half-year with no ETI is not read at all (one EXISTS each, nothing posted)', async () => {
    vi.mocked(periodHasEti).mockImplementation(async () => false);
    await rebookEtiAfterEvent(CO, { year: 2026, month: 9 }, 'u1', '2026-11-12');
    expect(postMonthEtiJournal).not.toHaveBeenCalled();
    expect(vi.mocked(periodHasEti).mock.calls.map((c) => c[1])).toEqual([{ year: 2026, month: 3 }, { year: 2026, month: 9 }]);
  });
  it('tdd L2: a month that ends TODAY is rebooked; the day before its end it is not', async () => {
    vi.mocked(periodHasEti).mockImplementation(async (_c, ym) => ym.month === 9);
    await rebookEtiAfterEvent(CO, { year: 2026, month: 9 }, 'u1', '2026-10-31');
    expect(postedMonths()).toEqual(['2026-09@2026-09-30', '2026-10@2026-10-31']);
    vi.mocked(postMonthEtiJournal).mockClear();
    await rebookEtiAfterEvent(CO, { year: 2026, month: 9 }, 'u1', '2026-10-30');
    expect(postedMonths()).toEqual(['2026-09@2026-09-30']);
  });
  it('rev L3: today is the SAST date (00:30 on 1 November in Johannesburg is 22:30 on 31 October UTC)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T22:30:00Z'));
    vi.mocked(periodHasEti).mockImplementation(async (_c, ym) => ym.month === 9);
    await rebookEtiAfterEvent(CO, { year: 2026, month: 11 }, 'u1');
    expect(postedMonths()).toEqual(['2026-09@2026-09-30', '2026-10@2026-10-31']);
    vi.mocked(postMonthEtiJournal).mockClear();
    vi.setSystemTime(new Date('2026-10-30T21:30:00Z')); // 23:30 on 30 October in SAST: October has not ended
    await rebookEtiAfterEvent(CO, { year: 2026, month: 11 }, 'u1');
    expect(postedMonths()).toEqual(['2026-09@2026-09-30']);
  });
});

describe('round 4 M2: the rebook date', () => {
  it('the month\'s last day while its period is open', async () => {
    expect(await etiRebookDate(CO, { year: 2026, month: 8 })).toBe('2026-08-31');
  });
  it('a closed month: the first open date after it; the journal keeps the month\'s reference (posted for August)', async () => {
    closed = new Set(['2026-08-31']); firstOpen = '2026-10-01';
    const r = await bookEtiForMonth(CO, { year: 2026, month: 8 }, 'u1', '2026-11-12');
    expect(r).toEqual({ month: '2026-08', status: 'booked', journalEntryId: 'je-eti', entryDate: '2026-10-01' });
    expect(postedMonths()).toEqual(['2026-08@2026-10-01']);
  });
  it('closed with no open period after it: not booked, a warning, never a ClosedFiscalPeriodError', async () => {
    closed = new Set(['2026-08-31']);
    const r = await bookEtiForMonth(CO, { year: 2026, month: 8 }, 'u1', '2026-11-12');
    expect(r.status).toBe('no_open_period');
    expect(postMonthEtiJournal).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('bookEtiForMonth / the explicit action (round 4 M1 (c))', () => {
  it('not ended, run journal in force, nothing to book, booked', async () => {
    expect((await bookEtiForMonth(CO, { year: 2026, month: 11 }, 'u1', '2026-11-12')).status).toBe('not_ended');
    inForce = new Set([202610]);
    expect((await bookEtiForMonth(CO, { year: 2026, month: 10 }, 'u1', '2026-11-12')).status).toBe('run_journal_in_force');
    vi.mocked(postMonthEtiJournal).mockResolvedValueOnce(null);
    expect((await bookEtiForMonth(CO, { year: 2026, month: 9 }, 'u1', '2026-11-12')).status).toBe('nothing_to_book');
    expect(postMonthEtiJournal).toHaveBeenCalledTimes(1);
  });
  it('the locked action takes lock 1 first, then books with the connector\'s posting agent', async () => {
    const order: string[] = [];
    vi.mocked(lockCompanyPayrollApprovals).mockImplementationOnce(async () => { order.push('lock'); });
    vi.mocked(postMonthEtiJournal).mockImplementationOnce(async () => { order.push('post'); return 'je-eti'; });
    await bookEtiForMonthLocked(CO, { year: 2026, month: 8 }, 'u1', 'mcp:book_eti_for_month:v1');
    expect(order).toEqual(['lock', 'post']);
    expect(vi.mocked(lockCompanyPayrollApprovals).mock.calls[0]).toEqual([null, CO]);
    expect(vi.mocked(postMonthEtiJournal).mock.calls[0]![4]).toBe('mcp:book_eti_for_month:v1');
  });
  it('the preview writes nothing and reports what would be booked', async () => {
    vi.mocked(etiDueForMonth).mockResolvedValueOnce({ used: 0, refund: 900 });
    expect(await previewEtiForMonth(CO, { year: 2026, month: 8 }, '2026-11-12'))
      .toEqual({ month: '2026-08', status: 'booked', entryDate: '2026-08-31', usedToBook: 0, refundToBook: 900 });
    expect(postMonthEtiJournal).not.toHaveBeenCalled();
  });
});

describe('after a directive payment\'s journal is reversed', () => {
  it('books the directive\'s month dated with the reversal, then the trigger rebook of its half-years', async () => {
    vi.mocked(periodHasEti).mockImplementation(async (_c, ym) => ym.month === 3);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-10T08:00:00Z'));
    await bookEtiAfterDirectiveReversal(CO, { source: 'auto_payroll', description: 'SARS directive D1 — Emp', entryDate: '2026-05-20' }, '2026-05-25', 'u1');
    expect(postedMonths()).toEqual(['2026-05@2026-05-25', '2026-03@2026-03-31', '2026-04@2026-04-30', '2026-05@2026-05-31', '2026-06@2026-06-30']);
  });
  it('ignores any other journal (a run journal, a manual one)', async () => {
    expect(await bookEtiAfterDirectiveReversal(CO, { source: 'auto_payroll', description: 'Payroll run 2026-05', entryDate: '2026-05-31' }, '2026-05-31', 'u1')).toBeNull();
    expect(await bookEtiAfterDirectiveReversal(CO, { source: 'manual', description: 'SARS directive D1', entryDate: '2026-05-31' }, '2026-05-31', 'u1')).toBeNull();
    expect(postMonthEtiJournal).not.toHaveBeenCalled();
  });
});
