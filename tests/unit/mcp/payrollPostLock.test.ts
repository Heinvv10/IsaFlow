/**
 * post_payroll_journal's live path: the run header is locked before the plan is read, and what each refusal says.
 * (Split out of payrollTools.test.ts, which is at its size cap.) The idempotency key serialises only calls that
 * share it; two posts under different keys, or a post beside an approval, both read a run with no journal and
 * each posted one, so the header lock is what orders them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ createPayrollRun: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunQueryService', () => ({ listPayRunsPage: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalBuilder', () => ({ buildPayrollJournalPlan: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalPostingService', () => ({ postPayrollRunJournal: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockPayrollRunHeader: vi.fn(), lockCompanyPayrollApprovals: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalControl', () => ({ assertPayRunApproved: vi.fn() }));
// The dry run reads the header unlocked; the figure it returns is the run's own header row.
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ id: '44444444-4444-4444-4444-444444444444', journal_entry_id: null }]) }));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';
import { assertPayRunApproved } from '@/modules/accounting/services/payroll/payRunApprovalControl';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { PayrollLoanLockTimeoutError } from '@/modules/accounting/services/payroll/payrollLoanLock';
import { postPayrollJournalTool } from '@/lib/mcp/tools/writePayroll';
import { GENERIC_FAILURE, thrownToolErrorText } from '@/lib/mcp/thrownToolErrorText';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const RUN = '44444444-4444-4444-4444-444444444444';
const KEY = { idempotency_key: 'k-1' };
const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333', companyId: COMPANY,
  scopes: ['write:payroll', 'write:post'], tokenJti: 'j', oauthAppId: null, companyRole: 'manager',
};
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
const plan = (over: Record<string, unknown> = {}) => ({
  runId: RUN, status: 'approved', alreadyPostedJournalId: null, entryDate: '2026-12-31', description: 'Payroll run 2026-12',
  lines: [], totalDebit: 0, totalCredit: 0, totals: {}, blockers: [], advisories: [], ...over,
}) as never;
const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lockPayrollRunHeader).mockResolvedValue({ id: RUN, journal_entry_id: null });
  vi.mocked(lockCompanyPayrollApprovals).mockResolvedValue(undefined);
  vi.mocked(assertPayRunApproved).mockResolvedValue({ grandfathered: true, planHash: null });
  vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan());
  vi.mocked(postPayrollRunJournal).mockResolvedValue('je-new');
});

describe('post_payroll_journal — the header lock', () => {
  it('RETHROWS a failure from the poster instead of returning toolError', async () => {
    // Once a service that can write has been called, a returned toolError releases the savepoint and COMMITs the
    // partial write, and frees the key for a retry that writes again.
    vi.mocked(postPayrollRunJournal).mockRejectedValue(new Error('boom'));
    await expect(postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx)).rejects.toThrow('boom');
  });

  it('takes the company approval lock, then the run header (payrollRunLock.ts order 1, 2), company-scoped, BEFORE it reads the plan on a live call', async () => {
    const order: string[] = [];
    vi.mocked(lockCompanyPayrollApprovals).mockImplementation(async () => { order.push('approvals'); });
    vi.mocked(lockPayrollRunHeader).mockImplementation(async () => { order.push('header'); return { id: RUN, journal_entry_id: null }; });
    vi.mocked(buildPayrollJournalPlan).mockImplementation(async () => { order.push('plan'); return plan(); });
    vi.mocked(postPayrollRunJournal).mockImplementation(async () => { order.push('post'); return 'je-new'; });
    await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    expect(order).toEqual(['approvals', 'header', 'plan', 'post']);
    expect(vi.mocked(lockCompanyPayrollApprovals).mock.calls[0]).toEqual([RUN, COMPANY]);
    expect(vi.mocked(lockPayrollRunHeader).mock.calls[0]).toEqual([RUN, COMPANY]);
  });

  it('refuses, naming the winner, when the plan read behind the lock finds the run already posted', async () => {
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue(plan({
      alreadyPostedJournalId: 'je-winner',
      blockers: [{ code: 'already_posted', detail: 'This run already posted journal je-winner. Reverse it before posting again.' }],
    }));
    const res = await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('je-winner');
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it('takes no lock on a dry run', async () => {
    await postPayrollJournalTool.handler({ run_id: RUN, dry_run: true, ...KEY }, ctx);
    expect(lockPayrollRunHeader).not.toHaveBeenCalled();
    expect(lockCompanyPayrollApprovals).not.toHaveBeenCalled();
  });

  it('answers a run of another company (no header to lock) with the shared not-found text', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValue(null);
    const res = await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Not found');
    expect(buildPayrollJournalPlan).not.toHaveBeenCalled();
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });
});

describe('post_payroll_journal — what a lost lock race says', () => {
  it('a post queued behind an approval or another post is told the run is BUSY, not that it is being calculated', async () => {
    vi.mocked(lockPayrollRunHeader).mockRejectedValue(new PayrollLoanLockTimeoutError(RUN));
    const res = await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(`Payroll run ${RUN} is being changed by another request — retry in a moment.`);
    expect(text(res)).not.toMatch(/calculated/);
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it('a post that times out on the COMPANY approval lock is told the run is busy too, and posts nothing', async () => {
    vi.mocked(lockCompanyPayrollApprovals).mockRejectedValue(new PayrollLoanLockTimeoutError(RUN));
    const res = await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(`Payroll run ${RUN} is being changed by another request — retry in a moment.`);
    expect(lockPayrollRunHeader).not.toHaveBeenCalled();
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it('a deadlock on the header lock is NOT swallowed by the tool: it propagates so the registry answers it (one mechanism)', async () => {
    vi.mocked(lockPayrollRunHeader).mockRejectedValue(deadlock);
    await expect(postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx)).rejects.toBe(deadlock);
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });
});

describe('a thrown 40P01 from ANY MCP tool (approve_pay_run\'s own locks included)', () => {
  it.each(['approve_pay_run', 'post_payroll_journal', 'void_payment'])('%s: retryable refusal, not GENERIC_FAILURE, no driver text', (tool) => {
    const out = thrownToolErrorText(tool, deadlock);
    expect(out).not.toBe(GENERIC_FAILURE);
    expect(out).toMatch(/^[a-z_]+: another request holds locks this one needs \(deadlock\)/);
    expect(out).toMatch(/nothing was written; retry in a moment/);
    expect(out).not.toMatch(/40P01|deadlock detected|opposite orders/);
  });

  it('leaves other errors generic', () => {
    expect(thrownToolErrorText('approve_pay_run', new Error('boom'))).toBe(GENERIC_FAILURE);
  });
});
