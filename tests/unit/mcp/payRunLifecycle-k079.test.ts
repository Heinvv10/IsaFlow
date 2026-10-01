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
  previewPayrollApproval: vi.fn(),
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
  previewPayrollApproval,
} from '@/modules/accounting/services/payroll/payrollApprovalService';
import { PayrollApprovalConflictError, PayrollApprovalRefusedError } from '@/modules/accounting/services/payroll/payrollApprovalRefusal';
import { PayrollLoanLockTimeoutError } from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { approvePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const JE = '33333333-3333-4333-8333-333333333333';
const KEY = { idempotency_key: 'k1' };
/** A live approve_pay_run call: it must carry the hash its dry run returned. */
const LIVE = { ...KEY, expected_plan_hash: 'hash-1' };
const gate = (over: Record<string, unknown> = {}) => ({ blocker: null, planHash: 'hash-1', posted: null, replaces: null, ...over });

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
    vi.mocked(previewPayrollApproval).mockResolvedValue(gate() as never);
  });

  it("returns the service's pre-write refusal (nothing written), without planning twice", async () => {
    vi.mocked(approvePayrollRun).mockRejectedValue(new PayrollApprovalRefusedError('no GL account for 2140'));
    expect(errText(await approvePayRunTool.handler({ run_id: RUN, ...LIVE }, ctx())))
      .toContain('no GL account for 2140');
    expect(previewPayrollApproval).not.toHaveBeenCalled();
  });

  it('dry run asks the same blocker question, scoped to the company', async () => {
    await approvePayRunTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx());
    expect(previewPayrollApproval).toHaveBeenCalledWith(COMPANY, RUN);
  });

  it('dry run refuses the same blocked run the live call refuses', async () => {
    vi.mocked(previewPayrollApproval).mockResolvedValue(gate({ blocker: { code: 'unbalanced', detail: 'unbalanced by 5.00' } }) as never);
    expect(errText(await approvePayRunTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx())))
      .toContain('unbalanced by 5.00');
  });

  it('dry run of a reopened run says its existing journal is returned, not that one is posted', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'calculated', journalEntryId: JE }) as never);
    vi.mocked(previewPayrollApproval).mockResolvedValue(gate({ posted: { journalEntryId: JE } }) as never);
    const out = parseOk(await approvePayRunTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx()));
    const effect = String((out.effects as string[])[0]);
    expect(effect).toContain(JE);
    expect(effect).toContain('nothing new is posted');
    expect(effect).not.toContain('POST its journal');
  });
});

// W3-01 breaker round 3: the tool's dry run and its live call carried no hash,
// so an agent approved whatever the run held by then. inputSchema is not
// validated at runtime — the handler is what enforces it.
describe('approve_pay_run — the live call approves what the dry run showed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'calculated' }) as never);
    vi.mocked(approvePayrollRun).mockResolvedValue(
      { ...run({ status: 'approved' }), journalEntryId: JE, advisories: [] } as never,
    );
    vi.mocked(previewPayrollApproval).mockResolvedValue(gate({ planHash: 'hash-9' }) as never);
  });

  it('the dry run returns the hash of the plan it previewed', async () => {
    const out = parseOk(await approvePayRunTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx()));
    expect(out.plan_hash).toBe('hash-9');
  });

  it.each([[undefined], [''], [['hash-9']], [9]])('a live call with expected_plan_hash %j is refused before anything is read', async (hash) => {
    const text = errText(await approvePayRunTool.handler({ run_id: RUN, expected_plan_hash: hash, ...KEY }, ctx()));
    expect(text).toContain('expected_plan_hash is required');
    expect(getPayrollRun).not.toHaveBeenCalled();
    expect(approvePayrollRun).not.toHaveBeenCalled();
  });

  it('the live call hands the hash to the service, whose conflict comes back as a refusal', async () => {
    vi.mocked(approvePayrollRun).mockRejectedValue(new PayrollApprovalConflictError('Payroll run changed while you were reviewing it'));
    const text = errText(await approvePayRunTool.handler({ run_id: RUN, expected_plan_hash: 'hash-9', ...KEY }, ctx()));
    expect(text).toContain('changed while you were reviewing it');
    expect(approvePayrollRun).toHaveBeenCalledWith(
      COMPANY, RUN, ctx().userId, { postingAgent: 'mcp:approve_pay_run:v1', expectedPlanHash: 'hash-9' },
    );
  });

  // Round 4: approval waits at most 5s for the run and its journal. Raised
  // before any write, so it is returned for the agent to retry, not thrown.
  it('returns the lock timeout so the agent can retry', async () => {
    vi.mocked(approvePayrollRun).mockRejectedValue(new PayrollLoanLockTimeoutError(RUN));
    expect(errText(await approvePayRunTool.handler({ run_id: RUN, ...LIVE }, ctx()))).toContain('retry in a moment');
  });

  it('the dry run of a run whose journal was reversed says a new one is posted in its place', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'calculated', journalEntryId: JE }) as never);
    vi.mocked(previewPayrollApproval).mockResolvedValue(gate({ replaces: { journalEntryId: JE } }) as never);
    const effect = String((parseOk(await approvePayRunTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx())).effects as string[])[0]);
    expect(effect).toContain('POST its journal');
    expect(effect).toContain(`${JE}) was reversed`);
    expect(effect).not.toContain('nothing new is posted');
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
    vi.mocked(previewPayrollApproval).mockResolvedValue(gate({ blocker: { code: 'nothing_to_post', detail: 'every journal line is zero' } }) as never);
    const r = await approvePayRunTool.handler({ run_id: RUN, ...LIVE }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('costed nobody');
    expect(approvePayrollRun).not.toHaveBeenCalled();
  });

  it('refuses an already-approved run rather than passing it to a service throw', async () => {
    // The service admits 'approved' only when the journal did not post, which
    // this summary cannot see. post_payroll_journal is the recovery.
    vi.clearAllMocks();
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'approved' }) as never);
    const r = await approvePayRunTool.handler({ run_id: RUN, ...LIVE }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('post_payroll_journal');
    expect(approvePayrollRun).not.toHaveBeenCalled();
  });
});
