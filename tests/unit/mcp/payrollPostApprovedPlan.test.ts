/**
 * post_payroll_journal posts only the journal a person approved. The live call and its dry run both read the plan
 * through readApprovedPlan: the run must be approved and the plan must hash to the approved plan hash, else both
 * refuse (dry-run parity, docs/mcp/CONTRACTS.md §6). The hash is the real one (payrollApprovalHash); only the
 * database, the locks and the plan builder are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ createPayrollRun: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunQueryService', () => ({ listPayRunsPage: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalBuilder', () => ({ buildPayrollJournalPlan: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalPostingService', () => ({ postPayrollRunJournal: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockPayrollRunHeader: vi.fn(), lockCompanyPayrollApprovals: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalControl', () => ({ assertPayRunApproved: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { assertPayRunApproved } from '@/modules/accounting/services/payroll/payRunApprovalControl';
import { hashOf } from '@/modules/accounting/services/payroll/payrollApprovalHash';
import { PLAN_CHANGED_SINCE_APPROVAL } from '@/modules/accounting/services/payroll/payrollApprovedPlan';
import { postPayrollJournalTool } from '@/lib/mcp/tools/writePayroll';
import type { PayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const RUN = '44444444-4444-4444-4444-444444444444';
const REVISION = '55555555-5555-5555-5555-555555555555';
const KEY = { idempotency_key: 'k-1' };
const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333', companyId: COMPANY,
  scopes: ['write:payroll', 'write:post'], tokenJti: 'j', oauthAppId: null, companyRole: 'manager',
};
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

const plan = (cc1Id: string | null = null, over: Record<string, unknown> = {}): PayrollJournalPlan => ({
  runId: RUN, status: 'approved', periodMonth: 12, periodYear: 2026, employeeCount: 1, alreadyPostedJournalId: null,
  entryDate: '2026-12-31', description: 'Payroll run 2026-12', reference: 'PAY-2026-12',
  lines: [
    { glAccountId: 'a5200', accountCode: '5200', accountName: 'Labour', debit: 100, credit: 0, description: 'Labour', inactiveAccount: false, cc1Id },
    { glAccountId: 'a1110', accountCode: '1110', accountName: 'Bank', debit: 0, credit: 100, description: 'Net pay', inactiveAccount: false, cc1Id: null },
  ],
  totalDebit: 100, totalCredit: 100,
  totals: { gross: 100, paye: 0, uif: 0, sdl: 0, eti: 0, etiUsed: 0, net: 100, employerUif: 0, otherDeductions: 0 },
  blockers: [], advisories: [], ...over,
} as unknown as PayrollJournalPlan);

/** The hash approval stored for `p`: approval hashes the run from its pre-approval status. */
const approvedHash = (p: PayrollJournalPlan, revision: string | null = REVISION): string =>
  hashOf({ ...p, status: 'calculated' }, null, null, revision);

const APPROVED = plan('cc-a');
let header: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  header = { id: RUN, journal_entry_id: null, approval_revision: REVISION };
  vi.mocked(lockCompanyPayrollApprovals).mockResolvedValue(undefined);
  vi.mocked(lockPayrollRunHeader).mockImplementation((async () => header) as never);
  vi.mocked(sql).mockImplementation((async () => [header]) as never);
  vi.mocked(postPayrollRunJournal).mockResolvedValue('je-new');
  vi.mocked(assertPayRunApproved).mockResolvedValue({ grandfathered: false, planHash: approvedHash(APPROVED) });
});

const call = (dry: boolean) => postPayrollJournalTool.handler({ run_id: RUN, ...(dry ? { dry_run: true } : {}), ...KEY }, ctx);

describe('post_payroll_journal posts only the approved plan', () => {
  it.each([[false], [true]])('dry_run=%s: passes when the plan hashes to the approved hash', async (dry) => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(APPROVED);
    const res = await call(dry);
    expect(res.isError).toBeUndefined();
    expect(vi.mocked(postPayrollRunJournal).mock.calls.length).toBe(dry ? 0 : 1);
  });

  it('live: posts exactly the plan it read and hash-matched (the reported plan)', async () => {
    const reported = plan('cc-a');
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(reported);
    await call(false);
    expect(vi.mocked(postPayrollRunJournal).mock.calls[0]![3]?.plan).toBe(reported);
  });

  it.each([
    ['a cost-centre mapping moved since approval', () => plan('cc-b'), REVISION],
    ['the run was reopened and re-approved onto another revision', () => plan('cc-a'), 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
  ])('live AND dry run both refuse, posting nothing, when %s', async (_name, build, revision) => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(build());
    header = { id: RUN, journal_entry_id: null, approval_revision: revision };
    const live = await call(false);
    const dry = await call(true);
    for (const res of [live, dry]) {
      expect(res.isError).toBe(true);
      expect(text(res)).toBe(PLAN_CHANGED_SINCE_APPROVAL);
    }
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it('the dry run takes no lock, the live call takes both, in order', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan('cc-b'));
    await call(true);
    expect(lockCompanyPayrollApprovals).not.toHaveBeenCalled();
    expect(lockPayrollRunHeader).not.toHaveBeenCalled();
    await call(false);
    const [approvals] = vi.mocked(lockCompanyPayrollApprovals).mock.invocationCallOrder;
    const [headerLock] = vi.mocked(lockPayrollRunHeader).mock.invocationCallOrder;
    expect(approvals).toBeLessThan(headerLock!);
  });

  it.each([[false], [true]])('dry_run=%s: a run approved before the hash existed (grandfathered) is not hash-matched', async (dry) => {
    vi.mocked(assertPayRunApproved).mockResolvedValue({ grandfathered: true, planHash: null });
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan('cc-b'));
    expect((await call(dry)).isError).toBeUndefined();
  });

  it.each([[false], [true]])('dry_run=%s: an unapproved run asks for a person, not for a hash', async (dry) => {
    vi.mocked(assertPayRunApproved).mockRejectedValue(new Error('Pay run is not approved, so it has no reviewed approval plan'));
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan('cc-b'));
    const res = await call(dry);
    expect(text(res)).toContain('A person must approve this pay run in ISAFlow');
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it.each([[false], [true]])('dry_run=%s: a plan blocked for its own reason names that reason, not the hash', async (dry) => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan('cc-b', { blockers: [{ code: 'loan_exceeds_pay', detail: 'A loan repayment is above pay.' }] }));
    const res = await call(dry);
    expect(text(res)).toContain('loan_exceeds_pay');
    expect(text(res)).not.toBe(PLAN_CHANGED_SINCE_APPROVAL);
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it.each([[false], [true]])('dry_run=%s: a run of another company reads as not found', async (dry) => {
    header = null as never;
    vi.mocked(lockPayrollRunHeader).mockResolvedValue(null);
    vi.mocked(sql).mockResolvedValue([] as never);
    const res = await call(dry);
    expect(text(res)).toBe('Not found');
    expect(buildPayrollJournalPlan).not.toHaveBeenCalled();
  });
});
