/**
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

vi.mock('@/lib/mcp/tools/payrollPreviewApproval', () => ({
  payrollApprovalRequired: vi.fn(async () => false),
  PAYROLL_APPROVAL_REQUIRED_TEXT: 'approval required',
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({
  calculatePayrollRun: vi.fn(),
  getPayrollRun: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', () => ({
  approvePayrollRun: vi.fn(),
}));

import {
  calculatePayrollRun,
  getPayrollRun,
} from '@/modules/accounting/services/payroll/payrollRunService';
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { PayrollRunLockedError } from '@/modules/accounting/services/payroll/payrollRunLock';
import { approvePayRunTool, calculatePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
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

describe('calculate_pay_run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPayrollRun).mockResolvedValue(run() as never);
    vi.mocked(calculatePayrollRun).mockResolvedValue(run({ status: 'calculated' }) as never);
  });

  it('does NOT require write:post — costing writes no journal', () => {
    expect(calculatePayRunTool.requiresPost).toBeUndefined();
    expect(approvePayRunTool.requiresPost).toBe(true);
  });

  it('costs the run and reports the totals', async () => {
    const out = parseOk(await calculatePayRunTool.handler({ run_id: RUN, ...KEY }, ctx()));
    expect(out.status).toBe('calculated');
    expect(out.period).toBe('04/2025');
    expect(out.total_gross).toBe(250000);
    expect(out.total_paye).toBe(45000);
    expect(calculatePayrollRun).toHaveBeenCalledWith(RUN, COMPANY);
  });

  it('flags a run that costed NOBODY rather than reporting success plainly', async () => {
    // An employee with no components costs to zero without erroring. Approving
    // that marks the month done and posts nothing.
    vi.mocked(calculatePayrollRun).mockResolvedValue(
      run({ status: 'calculated', employeeCount: 0, totalGross: 0, totalNet: 0 }) as never,
    );
    const out = parseOk(await calculatePayRunTool.handler({ run_id: RUN, ...KEY }, ctx()));
    expect(out.employee_count).toBe(0);
    expect(String(out.next_step)).toContain('assign_employee_component');
  });

  it('returns the locked refusal rather than throwing it', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValue(new PayrollRunLockedError('approved'));
    const r = await calculatePayRunTool.handler({ run_id: RUN, ...KEY }, ctx());
    expect(r.isError).toBe(true);
  });

  it('RETHROWS anything else so the savepoint sees it', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValue(new Error('engine blew up'));
    await expect(calculatePayRunTool.handler({ run_id: RUN, ...KEY }, ctx()))
      .rejects.toThrow('engine blew up');
  });

  it('refuses a foreign run generically, before costing', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue(null);
    expect(errText(await calculatePayRunTool.handler({ run_id: RUN, ...KEY }, ctx())))
      .toBe('Not found');
    expect(calculatePayrollRun).not.toHaveBeenCalled();
  });

  it('dry run writes nothing', async () => {
    const out = parseOk(await calculatePayRunTool.handler(
      { run_id: RUN, dry_run: true, ...KEY }, ctx(),
    ));
    expect(out.dryRun).toBe(true);
    expect(out.wroteNothing).toBe(true);
    expect(calculatePayrollRun).not.toHaveBeenCalled();
  });

  it('refuses a malformed run_id before any read', async () => {
    expect(errText(await calculatePayRunTool.handler({ run_id: 'nope', ...KEY }, ctx())))
      .toBe('invalid run_id');
    expect(getPayrollRun).not.toHaveBeenCalled();
  });
});

describe('approve_pay_run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'calculated' }) as never);
    vi.mocked(approvePayrollRun).mockResolvedValue(
      { ...run({ status: 'approved' }), journalEntryId: JE } as never,
    );
  });

  it('approves, posts, and returns the journal it wrote', async () => {
    const out = parseOk(await approvePayRunTool.handler({ run_id: RUN, ...KEY }, ctx()));
    expect(out.status).toBe('approved');
    expect(out.journal_entry_id).toBe(JE);
    expect(approvePayrollRun).toHaveBeenCalledWith(
      COMPANY, RUN, ctx().userId, { postingAgent: 'mcp:approve_pay_run:v1' },
    );
  });

  it('refuses a status the service would refuse, before posting', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue(run({ status: 'cancelled' }) as never);
    expect(errText(await approvePayRunTool.handler({ run_id: RUN, ...KEY }, ctx())))
      .toContain("status 'cancelled'");
    expect(approvePayrollRun).not.toHaveBeenCalled();
  });

  it('does NOT catch a failure during approve-and-post', async () => {
    // A returned error would RELEASE the savepoint and commit a run marked
    // approved against a journal that never posted.
    vi.mocked(approvePayrollRun).mockRejectedValue(new Error('period is closed'));
    await expect(approvePayRunTool.handler({ run_id: RUN, ...KEY }, ctx()))
      .rejects.toThrow('period is closed');
  });

  it('dry run reports the totals about to hit the ledger and posts nothing', async () => {
    const out = parseOk(await approvePayRunTool.handler(
      { run_id: RUN, dry_run: true, ...KEY }, ctx(),
    ));
    expect(out.dryRun).toBe(true);
    // Without wroteNothing the registry stores the preview under the real key
    // and the live call that follows is served the preview forever.
    expect(out.wroteNothing).toBe(true);
    expect(String((out.effects as string[])[0])).toContain('POST its journal');
    expect(approvePayrollRun).not.toHaveBeenCalled();
  });

  it('dry run flags an uncosted run as skipped', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue(run({ employeeCount: 0 }) as never);
    const out = parseOk(await approvePayRunTool.handler(
      { run_id: RUN, dry_run: true, ...KEY }, ctx(),
    ));
    expect((out.skipped as Array<{ reason: string }>)[0]!.reason).toBe('run_not_costed');
  });

  it('refuses a foreign run generically', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue(null);
    expect(errText(await approvePayRunTool.handler({ run_id: RUN, ...KEY }, ctx())))
      .toBe('Not found');
    expect(approvePayrollRun).not.toHaveBeenCalled();
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
