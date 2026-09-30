/**
 * W3-01 (PAY-01): the approval confirmation must refuse exactly what
 * approvePayrollRun refuses. `previewPayrollApproval` returns the plan and the
 * blocker judged by the same `approvalBlocker` approval uses:
 *   - 'run_not_approved' is not a blocker (approval itself resolves it);
 *   - any other plan blocker is;
 *   - a run that already carries its journal is refused by none of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalBuilder', () => ({ buildPayrollJournalPlan: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalPostingService', () => ({ postPayrollRunJournal: vi.fn() }));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { previewPayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalService';

const notApproved = { code: 'run_not_approved', detail: "This run is 'calculated'." };
const closed = { code: 'closed_period', detail: 'The fiscal period is closed.' };

function plan(blockers: Array<{ code: string; detail: string }>, alreadyPostedJournalId: string | null = null) {
  return { runId: 'r1', alreadyPostedJournalId, blockers, advisories: [], lines: [] } as never;
}

describe('previewPayrollApproval', () => {
  beforeEach(() => vi.mocked(buildPayrollJournalPlan).mockReset());

  it('passes the plan through and does not count run_not_approved as a blocker', async () => {
    const p = plan([notApproved]);
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(p);
    expect(await previewPayrollApproval('c1', 'r1')).toEqual({ plan: p, blocker: null });
    expect(buildPayrollJournalPlan).toHaveBeenCalledWith('c1', 'r1');
  });

  it('reports the first real blocker', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan([notApproved, closed]));
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker).toEqual(closed);
  });

  it('reports no blocker for a reopened run that still carries its journal', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan([closed], 'je-1'));
    expect((await previewPayrollApproval('c1', 'r1'))?.blocker).toBeNull();
  });

  it('is null when the run is not in the company', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(null);
    expect(await previewPayrollApproval('c1', 'r1')).toBeNull();
  });
});
