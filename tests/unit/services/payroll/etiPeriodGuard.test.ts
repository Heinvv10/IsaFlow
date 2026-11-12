/**
 * Hein ruling R-A (wave 5 ET, redesigned round 2): in an ETI period (March-August, September-February; Fourth Schedule
 * para 14(3)(a), ETI Act s9(1) and s10) that HAS ETI, no approve, reopen, recalculation or directive of a month while a
 * LATER month of the period has a journal IN FORCE. The guard, and the recalculation and reopen that call it (the
 * approval gate returns it as a blocker; directive and reversal callers have their own tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/payrollRunLoanComponents', () => ({
  appendLoanComponents: (components: unknown[]) => components,
  loadLoanComponents: async () => ({ deduction: { id: 'loan' }, fringe: { id: 'fringe' } }),
}));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(async () => []), { unsafe: vi.fn(() => '') }), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  isPayrollRunLocked: () => false,
  lockCompanyPayrollApprovals: vi.fn(),
  lockPayrollRunHeader: vi.fn(),
  PayrollRunLockedError: class extends Error {},
  REOPENABLE_STATUSES: new Set(['approved']),
  saveCalculatedRunTotals: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLoanApplication', () => ({ applyRunLoans: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/payrollJournalChain')>()),
  payrollJournalInForce: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/payroll/etiRebook', () => ({ rebookEtiAfterEvent: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalAudit', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/payRunApprovalAudit')>()),
  recordPayRunApprovalAudit: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollRunEmployees: vi.fn(async () => []),
  listTaxNumbersForCompany: vi.fn(async () => []),
}));

import { sql } from '@/lib/neon';
import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { applyRunLoans } from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { payrollJournalInForce } from '@/modules/accounting/services/payroll/payrollJournalChain';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { rebookEtiAfterEvent } from '@/modules/accounting/services/payroll/etiRebook';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunReopen';
import {
  earlierUnapprovedRefusal, EtiLaterMonthPostedError, laterEtiJournalRefusal, reconciliationEnd,
} from '@/modules/accounting/services/payroll/etiPeriodGuard';

const CO = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const hasEti = (yes = true) => vi.mocked(sql).mockResolvedValueOnce([{ has_eti: yes }] as never);
const laterInForce = (y: number, m: number, status = 'approved') => vi.mocked(sql).mockResolvedValueOnce([{ y, m, id: 'je-later', status }] as never);
const queries = () => vi.mocked(sql).mock.calls.map((c) => ({ q: (c[0] as TemplateStringsArray).join('?'), v: c.slice(1) }));

beforeEach(() => { vi.clearAllMocks(); vi.mocked(payrollJournalInForce).mockResolvedValue(true); });

describe('the guard', () => {
  it('the period ends in August or February', () => {
    expect(reconciliationEnd({ year: 2026, month: 5 })).toEqual({ year: 2026, month: 8 });
    expect(reconciliationEnd({ year: 2026, month: 10 })).toEqual({ year: 2027, month: 2 });
    expect(reconciliationEnd({ year: 2027, month: 1 })).toEqual({ year: 2027, month: 2 });
  });
  it('in a period with ETI, names the later month in force and the remedy; asks June-August only, company-scoped', async () => {
    hasEti(); laterInForce(2026, 6);
    const r = await laterEtiJournalRefusal(CO, { year: 2026, month: 5 });
    expect(r).toMatch(/June 2026 payroll journal is in the ledger/);
    expect(r).toMatch(/reopen the June 2026 pay run and reverse its journal/);
    const [eti, later] = queries();
    expect(eti!.q).toContain('h.total_eti <> 0');
    expect(eti!.v).toEqual([CO, '2026-03-01', '2026-08-01', CO, ['ETI-2026-03', 'ETI-2026-04', 'ETI-2026-05', 'ETI-2026-06', 'ETI-2026-07', 'ETI-2026-08']]);
    // Round 3: only later RUN journals count (a run-less month is rebooked, not a blocker): June-August, this company.
    expect(later!.q).toContain('h.journal_entry_id IS NOT NULL');
    expect(later!.q).not.toContain('gl_journal_entries');
    expect(later!.v).toEqual([CO, '2026-06-01', '2026-08-01']);
  });
  it('adv3 L5: a later PAID run gets its own message (it cannot be reopened)', async () => {
    hasEti(); laterInForce(2026, 6, 'paid');
    const r = await laterEtiJournalRefusal(CO, { year: 2026, month: 5 });
    expect(r).toMatch(/June 2026 pay run is paid and cannot be reopened/);
    expect(r).not.toMatch(/reopen the June 2026 pay run/);
  });
  it('a tenant with no ETI in the period is never blocked (and nothing later is read)', async () => {
    hasEti(false);
    expect(await laterEtiJournalRefusal(CO, { year: 2026, month: 5 })).toBeNull();
    expect(queries()).toHaveLength(1);
  });
  it('a later journal reversed out of the ledger (not in force) does not block', async () => {
    hasEti(); laterInForce(2026, 6);
    vi.mocked(payrollJournalInForce).mockResolvedValueOnce(false);
    expect(await laterEtiJournalRefusal(CO, { year: 2026, month: 5 })).toBeNull();
  });
  it('August (the last month) has no later month in its period: September never blocks it', async () => {
    hasEti();
    expect(await laterEtiJournalRefusal(CO, { year: 2026, month: 8 })).toBeNull();
    expect(queries()).toHaveLength(1);
  });
  it('February\'s later months are none; January looks at February only', async () => {
    hasEti(); laterInForce(2027, 2);
    expect(await laterEtiJournalRefusal(CO, { year: 2027, month: 1 })).toMatch(/February 2027/);
    expect(queries()[1]!.v.slice(1, 3)).toEqual(['2027-02-01', '2027-02-01']);
  });
  it('review L4: an earlier calculated, unapproved month of an ETI period must be approved first', async () => {
    hasEti(); vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 4 }] as never);
    expect(await earlierUnapprovedRefusal(CO, { year: 2026, month: 5 })).toMatch(/April 2026 pay run is calculated but not approved/);
    // tdd3 M1: calculated runs from March up to, NOT including, May (May's own run never counts), this company.
    const q = queries()[1]!;
    expect(q.q).toContain("h.status = 'calculated'");
    expect(q.q).toMatch(/>= \?::date[\s\S]*< \?::date/);
    expect(q.v).toEqual([CO, '2026-03-01', '2026-05-01']);
    expect(await earlierUnapprovedRefusal(CO, { year: 2026, month: 3 })).toBeNull(); // March starts the period
  });
});

describe('its callers', () => {
  it('a recalculation of May is refused (409) before loans are applied when June is in force', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({ id: RUN, company_id: CO, status: 'calculated', period_month: 5, period_year: 2026 } as never);
    hasEti(); laterInForce(2026, 6);
    const err = await calculatePayrollRun(RUN, CO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtiLaterMonthPostedError);
    expect((err as EtiLaterMonthPostedError).status).toBe(409);
    expect(applyRunLoans).not.toHaveBeenCalled();
  });
  it('a reopen of May is refused before its UPDATE when June is in force', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({ id: RUN, company_id: CO, status: 'approved', period_month: 5, period_year: 2026 } as never);
    hasEti(); laterInForce(2026, 6);
    await expect(reopenPayrollRun({ runId: RUN, companyId: CO, userId: 'u', reason: 'fix May hours' })).rejects.toThrow(/June 2026/);
    expect(queries().some((c) => c.q.includes('UPDATE payroll_run_headers'))).toBe(false);
  });
  it('review L5: a reopen of a PAID run says it is paid (status first), before any ETI read', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({ id: RUN, company_id: CO, status: 'paid', period_month: 5, period_year: 2026 } as never);
    await expect(reopenPayrollRun({ runId: RUN, companyId: CO, userId: 'u', reason: 'fix May hours' })).rejects.toThrow(/Paid runs cannot be reopened/);
    expect(queries().some((c) => c.q.includes('has_eti'))).toBe(false);
  });
  it('round 3: a reopen that goes through rebooks the later run-less months of May\'s ETI period', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({ id: RUN, company_id: CO, status: 'approved', period_month: 5, period_year: 2026 } as never);
    hasEti(false);
    vi.mocked(sql).mockResolvedValueOnce([{ id: RUN }] as never); // the reopen UPDATE
    await reopenPayrollRun({ runId: RUN, companyId: CO, userId: 'u', reason: 'fix May hours' });
    expect(rebookEtiAfterEvent).toHaveBeenCalledWith(CO, { year: 2026, month: 5 }, 'u');
  });
});
