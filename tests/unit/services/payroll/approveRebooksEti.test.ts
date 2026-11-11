/**
 * Wave 5 ET review round 3 (adv3 M2/M3): approving a run rebooks the later run-less months of its ETI period, after
 * the run's journal posts and under the locks approval already holds (lock 1 first). The rebook itself is tested in
 * directiveEtiJournal.test.ts; this pins the call.
 */
import { describe, expect, it, vi } from 'vitest';

const order: string[] = [];
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: async () => undefined }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => [{ id: 'r1', company_id: 'c1', period_month: 6, period_year: 2026, status: 'approved' }]),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(vi.fn(async () => [{ id: 'r1' }]))),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  lockCompanyPayrollApprovals: vi.fn(async () => { order.push('lock1'); }),
  lockPayrollRunHeader: vi.fn(async () => ({ id: 'r1', journal_entry_id: null })),
  lockRunJournalForApproval: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalGate', () => ({
  judgePayrollApproval: vi.fn(async () => ({
    plan: { runId: 'r1', periodYear: 2026, periodMonth: 6, advisories: [], blockers: [] }, blocker: null, posted: null, replaces: null, planHash: 'h',
  })),
}));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalControl', () => ({ assertPayRunApproved: vi.fn(async () => ({})) }));
vi.mock('@/modules/accounting/services/payroll/payRunDecision', () => ({ readPayRunDecision: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunDirectiveClaim', () => ({ claimRunSeveranceDirectives: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalAudit', () => ({ recordPayRunApprovalAudit: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalPostingService', () => ({ postPayrollRunJournal: vi.fn(async () => { order.push('post'); return 'je1'; }) }));
vi.mock('@/modules/accounting/services/payroll/directiveEtiJournal', () => ({ rebookLaterRunlessMonths: vi.fn(async () => { order.push('rebook'); return []; }) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ mapRunRow: (r: unknown) => r }));

import { rebookLaterRunlessMonths } from '@/modules/accounting/services/payroll/directiveEtiJournal';
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';

describe('approvePayrollRun', () => {
  it("posts the run journal, then rebooks the later run-less months of June's ETI period, with lock 1 taken first", async () => {
    await approvePayrollRun('c1', 'r1', 'u1');
    expect(order).toEqual(['lock1', 'post', 'rebook']);
    expect(rebookLaterRunlessMonths).toHaveBeenCalledWith('c1', { year: 2026, month: 6 }, 'u1');
  });
});
