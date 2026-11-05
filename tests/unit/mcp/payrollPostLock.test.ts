/**
 * post_payroll_journal's live path: the run header is locked before the plan is read, and what each refusal says.
 * (Split out of payrollTools.test.ts, which is at its size cap.) The idempotency key serialises only calls that
 * share it; two posts under different keys, or a post beside an approval, both read a run with no journal and
 * each posted one, so the header lock is what orders them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ createPayrollRun: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunQueryService', () => ({ listPayRunsPage: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalBuilder', () => ({ buildPayrollJournalPlan: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalPostingService', () => ({ postPayrollRunJournal: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockPayrollRunHeader: vi.fn() }));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';
import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { PayrollLoanLockTimeoutError } from '@/modules/accounting/services/payroll/payrollLoanLock';
import { PayrollJournalDeadlockError } from '@/modules/accounting/services/payroll/payrollJournalDeadlock';
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

  it('locks the run header, company-scoped, BEFORE it reads the plan on a live call', async () => {
    const order: string[] = [];
    vi.mocked(lockPayrollRunHeader).mockImplementation(async () => { order.push('lock'); return { id: RUN, journal_entry_id: null }; });
    vi.mocked(buildPayrollJournalPlan).mockImplementation(async () => { order.push('plan'); return plan(); });
    await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    expect(order).toEqual(['lock', 'plan']);
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

  it('a deadlock on the header lock (a batch locking runs in opposite orders) is a retryable tool error', async () => {
    vi.mocked(lockPayrollRunHeader).mockRejectedValue(deadlock);
    const res = await postPayrollJournalTool.handler({ run_id: RUN, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(new PayrollJournalDeadlockError(RUN).message);
    expect(text(res)).toMatch(/retry/);
    expect(postPayrollRunJournal).not.toHaveBeenCalled();
  });

  it('the poster\'s deadlock error keeps its own message when thrown, where a raw 40P01 would read GENERIC_FAILURE', () => {
    expect(thrownToolErrorText('post_payroll_journal', new PayrollJournalDeadlockError(RUN))).toBe(new PayrollJournalDeadlockError(RUN).message);
    expect(thrownToolErrorText('post_payroll_journal', deadlock)).toBe(GENERIC_FAILURE);
  });
});
