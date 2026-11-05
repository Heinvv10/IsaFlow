/**
 * postPayrollRunJournal against a run another request posted first: the header
 * is locked before the link is judged, a link the plan did not see is refused
 * before anything is written, and the stamp only lands on a run with no journal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';

const calls: string[] = [];
let stampRows: unknown[] = [{ id: 'run' }];

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray) => {
    calls.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return Promise.resolve(stampRows);
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockPayrollRunHeader: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalControl', () => ({ assertPayRunApproved: vi.fn() }));
// The no-plan read (locks, hash match) is judged in payrollApprovedPlan.test.ts and payrollPostApprovedPlan.test.ts.
vi.mock('@/modules/accounting/services/payroll/payrollApprovedPlan', () => ({ readApprovedPlan: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ createJournalEntry: vi.fn(async () => ({ id: 'je-new' })) }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn(), reverseJournalEntry: vi.fn() }));

import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { assertPayRunApproved } from '@/modules/accounting/services/payroll/payRunApprovalControl';
import { readApprovedPlan } from '@/modules/accounting/services/payroll/payrollApprovedPlan';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const plan = (alreadyPostedJournalId: string | null): PayrollJournalPlan => ({
  runId: RUN, status: 'approved', periodMonth: 12, periodYear: 2026, employeeCount: 1, alreadyPostedJournalId,
  entryDate: '2026-12-31', description: 'Payroll run 2026-12', reference: 'PAY-2026-12',
  lines: [
    { glAccountId: 'a5200', accountCode: '5200', accountName: 'Labour', debit: 100, credit: 0, description: 'Labour', inactiveAccount: false, cc1Id: null },
    { glAccountId: 'a1110', accountCode: '1110', accountName: 'Bank', debit: 0, credit: 100, description: 'Net pay', inactiveAccount: false, cc1Id: null },
  ],
  totalDebit: 100, totalCredit: 100,
  totals: { gross: 100, paye: 0, uif: 0, sdl: 0, eti: 0, etiUsed: 0, net: 100, employerUif: 0, otherDeductions: 0 },
  blockers: [], advisories: [],
} as unknown as PayrollJournalPlan);

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  stampRows = [{ id: RUN }];
  vi.mocked(lockPayrollRunHeader).mockResolvedValue({ id: RUN, journal_entry_id: null });
  vi.mocked(assertPayRunApproved).mockResolvedValue({ grandfathered: true, planHash: null });
  vi.mocked(readApprovedPlan).mockResolvedValue({ header: { id: RUN, journal_entry_id: null }, plan: plan(null) });
});

describe('postPayrollRunJournal under the header lock', () => {
  it('locks the run, company-scoped, before it creates the journal', async () => {
    const order: string[] = [];
    vi.mocked(lockPayrollRunHeader).mockImplementation(async () => { order.push('lock'); return { id: RUN, journal_entry_id: null }; });
    vi.mocked(createJournalEntry).mockImplementation((async () => { order.push('create'); return { id: 'je-new' }; }) as never);
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1', { plan: plan(null) })).resolves.toBe('je-new');
    expect(order).toEqual(['lock', 'create']);
    expect(vi.mocked(lockPayrollRunHeader).mock.calls[0]).toEqual([RUN, COMPANY]);
  });

  it('refuses, writing nothing, when the locked header already links a journal the plan did not see', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValue({ id: RUN, journal_entry_id: 'je-winner' });
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1', { plan: plan(null) })).rejects.toThrow(/already carries journal je-winner/);
    expect(createJournalEntry).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('is still a no-op, returning the link, when the plan saw the same journal (approval re-run)', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValue({ id: RUN, journal_entry_id: 'je-1' });
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1', { plan: plan('je-1') })).resolves.toBe('je-1');
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('answers a run not in the company as not found', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValue(null);
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1', { plan: plan(null) })).rejects.toThrow(/not found/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  // That the stamp only lands on an unlinked run is proved against a real database:
  // tests/integration/payroll-poster-stamp.int.test.ts.
  it('stamps the run, and refuses when the stamp matched no row', async () => {
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1', { plan: plan(null) })).resolves.toBe('je-new');
    expect(calls).toHaveLength(1);

    stampRows = [];
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1', { plan: plan(null) })).rejects.toThrow(/already carries a journal/);
  });
});

describe('postPayrollRunJournal handed no plan (recovery posting)', () => {
  it('reads the plan under the approval and header locks (readApprovedPlan, lock: true) and posts that plan', async () => {
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1')).resolves.toBe('je-new');
    expect(vi.mocked(readApprovedPlan).mock.calls).toEqual([[COMPANY, RUN, { lock: true }]]);
    expect(createJournalEntry).toHaveBeenCalledTimes(1);
  });

  it('refuses, writing nothing, when the header it locked links a journal the plan read under the lock did not see', async () => {
    vi.mocked(readApprovedPlan).mockResolvedValue({ header: { id: RUN, journal_entry_id: 'je-winner' }, plan: plan(null) });
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1')).rejects.toThrow(/already carries journal je-winner/);
    expect(createJournalEntry).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('refuses, writing nothing, when the plan no longer matches the approved one (readApprovedPlan throws)', async () => {
    vi.mocked(readApprovedPlan).mockRejectedValue(new Error('no longer matches the journal plan that was approved'));
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1')).rejects.toThrow(/no longer matches/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('answers a run not in the company as not found', async () => {
    vi.mocked(readApprovedPlan).mockResolvedValue(null);
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1')).rejects.toThrow(/not found/);
  });
});

describe('postPayrollRunJournal handed a plan', () => {
  it('still requires the run to be approved, writing nothing when it is not', async () => {
    vi.mocked(assertPayRunApproved).mockRejectedValue(new Error('Pay run is not approved, so it has no reviewed approval plan'));
    await expect(postPayrollRunJournal(COMPANY, RUN, 'u1', { plan: plan(null) })).rejects.toThrow(/not approved/);
    expect(createJournalEntry).not.toHaveBeenCalled();
    expect(readApprovedPlan).not.toHaveBeenCalled();
  });
});
