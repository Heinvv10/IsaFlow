/**
 * Rebooking run-less months (wave 5 ET; coordinator rulings, review rounds 3 and 4: M1 (a)-(d), M2 dating).
 * ETI Act s9(1), s10(1); SARS Guide to the Employment Tax Incentive, Issue 5, §7-§8.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const PLAN = { lines: [{ glAccountId: 'a', debit: 900, credit: 0 }, { glAccountId: 'b', debit: 0, credit: 900 }], used: 0, refund: 900 };
vi.mock('@/modules/accounting/services/payroll/directiveEtiJournal', () => ({
  postMonthEtiJournal: vi.fn(async () => 'je-eti'),
  etiMonthPlan: vi.fn(),
  postEtiPlan: vi.fn(async () => 'je-eti'),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({ payrollJournalInForce: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/payroll/etiPeriodGuard', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/etiPeriodGuard')>()),
  periodHasEti: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockCompanyPayrollApprovals: vi.fn(async () => undefined) }));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { etiMonthPlan, postEtiPlan, postMonthEtiJournal } from '@/modules/accounting/services/payroll/directiveEtiJournal';
import { periodHasEti } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { lockCompanyPayrollApprovals } from '@/modules/accounting/services/payroll/payrollRunLock';
import {
  bookEtiAfterDirectiveReversal, bookEtiForMonth, bookEtiForMonthLocked, etiRebookDate, monthHasEnded, previewEtiForMonth, rebookEtiAfterEvent,
} from '@/modules/accounting/services/payroll/etiRebook';

const CO = '11111111-1111-1111-1111-111111111111';
/** Months (y*100+m) whose run journal is in force; months whose fiscal period is closed; the first open date after them. */
let inForce = new Set<number>();
let closed = new Set<string>();
let firstOpen: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  inForce = new Set(); closed = new Set(); firstOpen = null;
  vi.mocked(etiMonthPlan).mockImplementation(async () => PLAN as never);
  posted.length = 0;
  vi.mocked(postEtiPlan).mockImplementation(async (_c, ym, _p, d) => { posted.push(fmt(ym, d)); return 'je-eti'; });
  vi.mocked(postMonthEtiJournal).mockImplementation(async (_c, ym, d) => { posted.push(fmt(ym, d)); return 'je-eti'; });
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

const fmt = (ym: { year: number; month: number }, d: unknown) => `${ym.year}-${String(ym.month).padStart(2, '0')}@${String(d)}`;
/** The months posted, in order: the directive month (postMonthEtiJournal) and the rebooks (postEtiPlan). */
const posted: string[] = [];
const postedMonths = () => posted;

describe('rebookEtiAfterEvent (round 4 M1 (a)/(b)): every run-less month of this and the previous half-year that has ended', () => {
  it('adv Repro A: a September trigger books the whole earlier half-year (August\'s refund) and September; July (run in force) and November (not ended) are left', async () => {
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
    expect(postedMonths()).toEqual([]);
    expect(vi.mocked(periodHasEti).mock.calls.map((c) => c[1])).toEqual([{ year: 2026, month: 3 }, { year: 2026, month: 9 }]);
  });
  it('adv L2 ruling (round 5): a month has ended only AFTER its last day: on 31 October October is not rebooked; on 1 November it is', async () => {
    vi.mocked(periodHasEti).mockImplementation(async (_c, ym) => ym.month === 9);
    await rebookEtiAfterEvent(CO, { year: 2026, month: 9 }, 'u1', '2026-10-31');
    expect(postedMonths()).toEqual(['2026-09@2026-09-30']);
    posted.length = 0;
    await rebookEtiAfterEvent(CO, { year: 2026, month: 9 }, 'u1', '2026-11-01');
    expect(postedMonths()).toEqual(['2026-09@2026-09-30', '2026-10@2026-10-31']);
    expect(monthHasEnded({ year: 2026, month: 10 }, '2026-10-31')).toBe(false);
    expect(monthHasEnded({ year: 2026, month: 10 }, '2026-11-01')).toBe(true);
  });
  it('rev L3: today is the SAST date (00:30 on 1 November in Johannesburg is still 31 October in UTC)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T22:30:00Z')); // SAST 1 November: October has ended
    vi.mocked(periodHasEti).mockImplementation(async (_c, ym) => ym.month === 9);
    await rebookEtiAfterEvent(CO, { year: 2026, month: 11 }, 'u1');
    expect(postedMonths()).toEqual(['2026-09@2026-09-30', '2026-10@2026-10-31']);
    posted.length = 0;
    vi.setSystemTime(new Date('2026-10-31T21:30:00Z')); // 23:30 on 31 October in SAST: October has not ended
    await rebookEtiAfterEvent(CO, { year: 2026, month: 11 }, 'u1');
    expect(postedMonths()).toEqual(['2026-09@2026-09-30']);
  });
  it('rev L1: a connector\'s trigger stamps every rebook it causes with its posting agent', async () => {
    vi.mocked(periodHasEti).mockImplementation(async (_c, ym) => ym.month === 9);
    await rebookEtiAfterEvent(CO, { year: 2026, month: 9 }, 'u1', '2026-11-12', 'mcp:approve_pay_run:v1');
    expect(vi.mocked(postEtiPlan).mock.calls.map((c) => c[5])).toEqual(['mcp:approve_pay_run:v1', 'mcp:approve_pay_run:v1']);
  });
});

describe('round 4 M2: the rebook date', () => {
  it('the month\'s last day while its period is open', async () => {
    expect(await etiRebookDate(CO, { year: 2026, month: 8 })).toBe('2026-08-31');
  });
  it('a closed month: the first open date after it; the journal keeps the month\'s reference (posted for August)', async () => {
    closed = new Set(['2026-08-31']); firstOpen = '2026-10-01';
    const r = await bookEtiForMonth(CO, { year: 2026, month: 8 }, 'u1', '2026-11-12');
    expect(r).toEqual({ month: '2026-08', status: 'booked', journalEntryId: 'je-eti', entryDate: '2026-10-01', used: 0, refund: 900 });
    expect(postedMonths()).toEqual(['2026-08@2026-10-01']);
  });
  it('closed with no open period after it: not booked, a warning, never a ClosedFiscalPeriodError', async () => {
    closed = new Set(['2026-08-31']);
    const r = await bookEtiForMonth(CO, { year: 2026, month: 8 }, 'u1', '2026-11-12');
    expect(r.status).toBe('no_open_period');
    expect(postEtiPlan).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('bookEtiForMonth / the explicit action (round 4 M1 (c))', () => {
  it('not ended, run journal in force, nothing to book, booked', async () => {
    expect((await bookEtiForMonth(CO, { year: 2026, month: 11 }, 'u1', '2026-11-12')).status).toBe('not_ended');
    inForce = new Set([202610]);
    expect((await bookEtiForMonth(CO, { year: 2026, month: 10 }, 'u1', '2026-11-12')).status).toBe('run_journal_in_force');
    vi.mocked(etiMonthPlan).mockResolvedValueOnce({ lines: [], used: 0, refund: 0 });
    expect(await bookEtiForMonth(CO, { year: 2026, month: 9 }, 'u1', '2026-11-12'))
      .toEqual({ month: '2026-09', status: 'nothing_to_book', journalEntryId: null, entryDate: '2026-09-30', used: 0, refund: 0 });
    expect(postEtiPlan).not.toHaveBeenCalled();
  });
  it('the locked action takes lock 1 first, then books with the connector\'s posting agent', async () => {
    const order: string[] = [];
    vi.mocked(lockCompanyPayrollApprovals).mockImplementationOnce(async () => { order.push('lock'); });
    vi.mocked(postEtiPlan).mockImplementationOnce(async () => { order.push('post'); return 'je-eti'; });
    await bookEtiForMonthLocked(CO, { year: 2026, month: 8 }, 'u1', 'mcp:book_eti_for_month:v1');
    expect(order).toEqual(['lock', 'post']);
    expect(vi.mocked(lockCompanyPayrollApprovals).mock.calls[0]).toEqual([null, CO]);
    expect(vi.mocked(postEtiPlan).mock.calls[0]![5]).toBe('mcp:book_eti_for_month:v1');
  });
  it('adv L1: the preview IS the real outcome (one plan): with no refund-receivable account both say nothing to book', async () => {
    vi.mocked(etiMonthPlan).mockResolvedValue({ lines: [], used: 0, refund: 0 }); // the plan drops a refund with no account
    const preview = await previewEtiForMonth(CO, { year: 2026, month: 8 }, '2026-11-12');
    expect(postEtiPlan).not.toHaveBeenCalled();
    const real = await bookEtiForMonth(CO, { year: 2026, month: 8 }, 'u1', '2026-11-12');
    const { journalEntryId: _id, ...realWithoutId } = real;
    expect(preview).toEqual(realWithoutId);
    expect(preview.status).toBe('nothing_to_book');
  });
  it('the preview of a month with a refund to book says what it would book, and writes nothing', async () => {
    expect(await previewEtiForMonth(CO, { year: 2026, month: 8 }, '2026-11-12'))
      .toEqual({ month: '2026-08', status: 'booked', entryDate: '2026-08-31', used: 0, refund: 900 });
    expect(postEtiPlan).not.toHaveBeenCalled();
  });
  it('adv L1: the plan\'s error (no 2140/5200) reaches the preview exactly as the real call', async () => {
    vi.mocked(etiMonthPlan).mockRejectedValue(new Error('GL accounts 2140 and 5200 are needed to book the month\'s ETI'));
    await expect(previewEtiForMonth(CO, { year: 2026, month: 8 }, '2026-11-12')).rejects.toThrow('2140 and 5200');
    await expect(bookEtiForMonth(CO, { year: 2026, month: 8 }, 'u1', '2026-11-12')).rejects.toThrow('2140 and 5200');
  });
});

describe('after a directive payment\'s journal is reversed', () => {
  it('books the directive\'s month dated with the reversal, then the trigger rebook of its half-years, all with the agent', async () => {
    vi.mocked(periodHasEti).mockImplementation(async (_c, ym) => ym.month === 3);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-10T08:00:00Z'));
    await bookEtiAfterDirectiveReversal(CO, { source: 'auto_payroll', description: 'SARS directive D1 — Emp', entryDate: '2026-05-20' }, '2026-05-25', 'u1', 'mcp:reverse_journal_entry:v1');
    expect(postedMonths()).toEqual(['2026-05@2026-05-25', '2026-03@2026-03-31', '2026-04@2026-04-30', '2026-05@2026-05-31', '2026-06@2026-06-30']);
    expect(vi.mocked(postMonthEtiJournal).mock.calls[0]![4]).toBe('mcp:reverse_journal_entry:v1');
    expect(new Set(vi.mocked(postEtiPlan).mock.calls.map((c) => c[5]))).toEqual(new Set(['mcp:reverse_journal_entry:v1']));
  });
  it('ignores any other journal (a run journal, a manual one)', async () => {
    expect(await bookEtiAfterDirectiveReversal(CO, { source: 'auto_payroll', description: 'Payroll run 2026-05', entryDate: '2026-05-31' }, '2026-05-31', 'u1')).toBeNull();
    expect(await bookEtiAfterDirectiveReversal(CO, { source: 'manual', description: 'SARS directive D1', entryDate: '2026-05-31' }, '2026-05-31', 'u1')).toBeNull();
    expect(postedMonths()).toEqual([]);
  });
});
