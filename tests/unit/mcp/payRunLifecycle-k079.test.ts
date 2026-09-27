/**
 * approve_pay_run under K-079: refusals before approval, dry-run parity, and a
 * reopened run's preview. Split from payRunLifecycle.test.ts (300-line cap);
 * same mocks. The original header follows.
 *
 * calculate_pay_run / approve_pay_run.
 *
 * What is worth pinning:
 *
 *  - `approve_pay_run` POSTS. `approvePayrollRun` approves and writes the GL
 *    journal in one call, so the tool is `requiresPost`; costing is not.
 *  - a run costed over employees with no components comes back with
 *    employee_count 0 and gross 0 WITHOUT erroring. The tool says so, because
 *    that silent zero is the one an agent would otherwise approve.
 *  - the locked-run refusal is returned, everything else is rethrown: a
 *    returned error would RELEASE the registry's savepoint and free the
 *    idempotency key for a retry that recomputes or re-posts.
 *  - both dry runs answer from a READ and write nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({
  calculatePayrollRun: vi.fn(),
  getPayrollRun: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', () => ({
  approvePayrollRun: vi.fn(),
  findApprovalBlocker: vi.fn(),
}));
// The error classes must be the real ones — the tool branches on them, and a
// stubbed sentinel would let those branches pass by accident.
vi.mock('@/modules/accounting/services/payroll/payrollRunLoanApplication', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/accounting/services/payroll/payrollRunLoanApplication')
  >('@/modules/accounting/services/payroll/payrollRunLoanApplication');
  return {
    PayrollLoanLockTimeoutError: actual.PayrollLoanLockTimeoutError,
    PayrollRunJournalPostedError: actual.PayrollRunJournalPostedError,
    runHasLoanWork: vi.fn(),
  };
});

import { getPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import {
  approvePayrollRun,
  findApprovalBlocker,
} from '@/modules/accounting/services/payroll/payrollApprovalService';
import { PayrollApprovalRefusedError } from '@/modules/accounting/services/payroll/payrollApprovalRefusal';
import { approvePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const JE = '33333333-3333-4333-8333-333333333333';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '55555555-5555-4555-8555-555555555555',
    companyId: COMPANY,
    scopes: ['write:payroll', 'write:post'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}

function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

const run = (over: Record<string, unknown> = {}) => ({
  id: RUN,
  companyId: COMPANY,
  periodMonth: 4,
  periodYear: 2025,
  status: 'draft',
  totalGross: 250000,
  totalPaye: 45000,
  totalUif: 1780,
  totalSdl: 2500,
  totalEti: 0,
  totalNet: 203220,
  employeeCount: 10,
  ...over,
});

describe('approve_pay_run — K-079', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'calculated' }) as never);
    vi.mocked(approvePayrollRun).mockResolvedValue(
      { ...run({ status: 'approved' }), journalEntryId: JE, advisories: [] } as never,
    );
    vi.mocked(findApprovalBlocker).mockResolvedValue(null);
  });

  it("returns the service's pre-write refusal (nothing written), without planning twice", async () => {
    vi.mocked(approvePayrollRun).mockRejectedValue(new PayrollApprovalRefusedError('no GL account for 2140'));
    expect(errText(await approvePayRunTool.handler({ run_id: RUN, ...KEY }, ctx())))
      .toContain('no GL account for 2140');
    expect(findApprovalBlocker).not.toHaveBeenCalled();
  });

  it('dry run asks the same blocker question, scoped to the company', async () => {
    await approvePayRunTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx());
    expect(findApprovalBlocker).toHaveBeenCalledWith(COMPANY, RUN);
  });

  it('dry run refuses the same blocked run the live call refuses', async () => {
    vi.mocked(findApprovalBlocker).mockResolvedValue({ code: 'unbalanced', detail: 'unbalanced by 5.00' });
    expect(errText(await approvePayRunTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx())))
      .toContain('unbalanced by 5.00');
  });

  it('dry run of a reopened run says its existing journal is returned, not that one is posted', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'calculated', journalEntryId: JE }) as never);
    const out = parseOk(await approvePayRunTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx()));
    const effect = String((out.effects as string[])[0]);
    expect(effect).toContain(JE);
    expect(effect).toContain('nothing new is posted');
    expect(effect).not.toContain('POST its journal');
  });
});

describe('approve_pay_run — the empty month is refused, not warned', () => {
  it('REFUSES to approve a run that costed nobody', async () => {
    // 'approved' is a LOCKED status, calculate_pay_run is refused permanently
    // afterwards, and there is no MCP tool to reopen a run — so an agent that
    // approved an empty month would have no connector path back out.
    vi.clearAllMocks();
    vi.mocked(getPayrollRun).mockResolvedValue(
      run({ status: 'calculated', employeeCount: 0, totalGross: 0 }) as never,
    );
    // The plan of an uncosted run is nothing_to_post; the named answer wins.
    vi.mocked(findApprovalBlocker).mockResolvedValue({ code: 'nothing_to_post', detail: 'every journal line is zero' });
    const r = await approvePayRunTool.handler({ run_id: RUN, ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('costed nobody');
    expect(approvePayrollRun).not.toHaveBeenCalled();
  });

  it('refuses an already-approved run rather than passing it to a service throw', async () => {
    // The service admits 'approved' only when the journal did not post, which
    // this summary cannot see. post_payroll_journal is the recovery.
    vi.clearAllMocks();
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'approved' }) as never);
    const r = await approvePayRunTool.handler({ run_id: RUN, ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('post_payroll_journal');
    expect(approvePayrollRun).not.toHaveBeenCalled();
  });
});
