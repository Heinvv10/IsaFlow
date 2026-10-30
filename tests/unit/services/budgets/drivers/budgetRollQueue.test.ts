/**
 * The rolling-forecast roll never blocks a close (Budgets P4 spec §6): queueing it only appends to
 * the request's after-commit list, never throws, and one request queues ONE job holding every end
 * date, run as the request principal and company; a company other than the request's is refused.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const run = vi.fn();
vi.mock('@/modules/accounting/services/budgets/drivers/budgetRollJob', () => ({ runBudgetRolls: run }));

import { als, type RequestContext } from '@/lib/als';
import { drainAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { scheduleBudgetRoll } from '@/modules/accounting/services/budgets/drivers/budgetRollQueue';

const ctx = (extra: Partial<RequestContext> = {}) =>
  ({ client: {}, userId: 'u1', companyId: 'c1', claims: { sub: 'u1', session_id: 's' }, afterCommit: [], ...extra }) as unknown as RequestContext;

describe('scheduleBudgetRoll', () => {
  it('queues ONE after-commit job per request, every end date per company, as the request principal', async () => {
    const c = ctx();
    als.run(c, () => {
      scheduleBudgetRoll('c1', '2026-03-31');
      scheduleBudgetRoll('c1', '2026-04-30');
      scheduleBudgetRoll('c1', '2026-03-31');
    });
    expect(c.afterCommit).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    drainAfterCommit(c);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith({ userId: 'u1', companyId: 'c1', claims: { sub: 'u1', session_id: 's' } }, ['2026-03-31', '2026-04-30']);
  });

  it("refuses (logged) a company other than the request's, queueing nothing", () => {
    const c = ctx();
    als.run(c, () => scheduleBudgetRoll('c2', '2026-03-31'));
    expect(c.afterCommit).toHaveLength(0);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringMatching(/not the request's/), expect.objectContaining({ companyId: 'c2', requestCompanyId: 'c1' }), 'accounting');
  });

  it('never throws: no request (logged, nothing queued), a finished request, a request that runs no after-commit work', () => {
    expect(() => scheduleBudgetRoll('c1', '2026-12-31')).not.toThrow();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith('budgets: rolling forecast roll skipped — no request principal', expect.anything(), 'accounting');
    expect(() => als.run(ctx({ finished: true }), () => scheduleBudgetRoll('c1', '2026-12-31'))).not.toThrow();
    expect(() => als.run(ctx({ afterCommit: undefined }), () => scheduleBudgetRoll('c1', '2026-12-31'))).not.toThrow();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith('budgets: could not queue the rolling forecast roll', expect.anything(), 'accounting');
  });
});
