/**
 * W3-01 (PAY-01): the approval confirmation must refuse exactly what
 * approvePayrollRun refuses. `previewPayrollApproval` returns the plan and the
 * blocker judged by the same `approvalBlocker` approval uses:
 *   - 'run_not_approved' is not a blocker (approval itself resolves it);
 *   - any other plan blocker is;
 *   - a run that already carries its journal is refused by none of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hein ruling R-A (wave 5 ET) has its own tests (etiPeriodGuard.test.ts): no later month posted here.
vi.mock('@/modules/accounting/services/payroll/etiPeriodGuard', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/etiPeriodGuard')>()),
  laterEtiJournalRefusal: vi.fn(async () => null),
  earlierUnapprovedRefusal: vi.fn(async () => null),
  assertNoLaterEtiJournal: vi.fn(async () => undefined),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalBuilder', () => ({ buildPayrollJournalPlan: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalPostingService', () => ({ postPayrollRunJournal: vi.fn() }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: async () => undefined }));
// Its own integration test (p4-termination-approval-gate); here, no duplicate pay-outs.
vi.mock('@/modules/accounting/services/payroll/payrollTerminationPaidCheck', () => ({ findTerminationsPaidElsewhere: vi.fn(async () => []) }));
// The pro-rata guard has its own tests (payroll-run-pro-rata-guard.int).
vi.mock('@/modules/accounting/services/payroll/payrollRecurringProRata', () => ({ runProRataBlocker: vi.fn(async () => null) }));
// Hours and days have their own tests (payrun-run-hours.int, payrollRunHours).
vi.mock('@/modules/accounting/services/payroll/payrollRunHoursGate', () => ({ hoursMissingBlocker: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunRegularDirective', () => ({ regularDirectiveRefusal: vi.fn(async () => null) }));
// The recalculation gates have their own tests (payroll-approval-recalc-gates.int).
vi.mock('@/modules/accounting/services/payroll/payrollRunRecalcGate', () => ({
  recalculateRequiredRefusal: vi.fn(async () => null), runLinesRefusal: vi.fn(async () => null),
}));
// Likewise (p3-severance-directive-run): no severance paid by directive.
vi.mock('@/modules/accounting/services/payroll/payrollRunDirectiveClaim', () => ({
  judgeRunDirectives: vi.fn(async () => null), claimRunSeveranceDirectives: vi.fn(async () => undefined),
  unpaidLeaverDirectiveNotes: vi.fn(async () => []),
}));
// Every sql call answers this row: the approve path's FOR UPDATE, and the posted journal's
// head (a live journal with no lines, matching the empty plans below).
const headerRow = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
// approvePayrollRun takes its header lock through withTransaction (payrollRunLock).
// The stale year-to-date blocker (PAYE 4a follow-ups G4) has its own tests (p4fu-brk-order, p4fu-cumulative-paye).
// Loan payments against the payslip have their own integration suite (payrun-loan-components).
vi.mock('@/modules/accounting/services/payroll/payrollRunLines', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/modules/accounting/services/payroll/payrollRunLines')>(),
  findLoanPaymentsOffPayslip: vi.fn(async () => ({ offPayslip: [], fringeNotRecorded: [] })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollYearToDateGate', () => ({ judgeYearToDate: vi.fn(async () => ({ blocker: null, advisories: [] })) }));
vi.mock('@/lib/neon', () => {
  const sql = vi.fn(async () => [headerRow.current]);
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { approvePayrollRun, previewPayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalService';

const notApproved = { code: 'run_not_approved', detail: "This run is 'calculated'." };
const closed = { code: 'closed_period', detail: 'The fiscal period is closed.' };

function plan(
  blockers: Array<{ code: string; detail: string }>,
  alreadyPostedJournalId: string | null = null,
  status = 'calculated',
) {
  return { runId: 'r1', status, alreadyPostedJournalId, blockers, advisories: [], lines: [], totals: {} } as never;
}

describe('previewPayrollApproval', () => {
  beforeEach(() => {
    vi.mocked(buildPayrollJournalPlan).mockReset();
    headerRow.current = { id: 'r1', status: 'posted', entry_number: 'JE-1', gl_account_id: null };
  });

  it('passes the plan through and does not count run_not_approved as a blocker', async () => {
    const p = plan([notApproved]);
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(p);
    expect(await previewPayrollApproval('c1', 'r1')).toEqual({ plan: p, blocker: null, posted: null, replaces: null, planHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(buildPayrollJournalPlan).toHaveBeenCalledWith('c1', 'r1');
  });

  it('reports the first real blocker', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan([notApproved, closed]));
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker).toEqual(closed);
  });

  it('Hein ruling R-A (wave 5 ET): a later month of the ETI period posted is a blocker naming it', async () => {
    const { laterEtiJournalRefusal } = await import('@/modules/accounting/services/payroll/etiPeriodGuard');
    vi.mocked(laterEtiJournalRefusal).mockResolvedValueOnce('The June 2026 payroll journal is already posted.');
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue({ ...(plan([notApproved]) as object), periodYear: 2026, periodMonth: 5 } as never);
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker).toEqual({ code: 'eti_later_month_posted', detail: 'The June 2026 payroll journal is already posted.' });
    expect(laterEtiJournalRefusal).toHaveBeenCalledWith('c1', { year: 2026, month: 5 });
  });

  it('review L4: an earlier calculated, unapproved month of the ETI period is a blocker', async () => {
    const { earlierUnapprovedRefusal } = await import('@/modules/accounting/services/payroll/etiPeriodGuard');
    vi.mocked(earlierUnapprovedRefusal).mockResolvedValueOnce('The April 2026 pay run is calculated but not approved.');
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue({ ...(plan([notApproved]) as object), periodYear: 2026, periodMonth: 5 } as never);
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker).toEqual({ code: 'eti_earlier_month_unapproved', detail: 'The April 2026 pay run is calculated but not approved.' });
  });

  it('reports no blocker for a reopened run that still carries its journal', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan([closed], 'je-1'));
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker).toBeNull();
  });

  // Round 1 (review MEDIUM): approvePayrollRun refuses these on status before
  // it builds the plan; the preview must report the same refusal, word for word.
  it('refuses a paid run with the message approval refuses it with', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan([notApproved], 'je-1', 'paid'));
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker).toEqual({
      code: 'status_not_approvable',
      detail: "Cannot approve payroll run with status 'paid' (expected one of: draft, calculated)",
    });
  });

  it('refuses an approved run that already carries its journal', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan([], 'je-1', 'approved'));
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker?.code).toBe('status_not_approvable');
  });

  it.each([
    ['processed', null],
    ['paid', 'je-1'],
    ['approved', 'je-1'],
    ['cancelled', null],
  ])('approval and its preview refuse a %s run (journal %s) with the same words', async (status, je) => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan([], je, status));
    headerRow.current = { id: 'r1', status, journal_entry_id: je };
    const preview = await previewPayrollApproval('c1', 'r1');
    await expect(approvePayrollRun('c1', 'r1', 'u1')).rejects.toThrow(preview!.blocker!.detail);
  });

  it('does not refuse an approved run whose journal never posted (re-approvable)', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan([], null, 'approved'));
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker).toBeNull();
  });

  it('is null when the run is not in the company', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(null);
    expect(await previewPayrollApproval('c1', 'r1')).toBeNull();
  });
});
