/**
 * Wave 6 FQd: create_pay_run for a weekly or fortnightly period. The dry run runs the live call's checks (the period
 * rule, a duplicate, an overlap) and writes nothing; month/year and period_start are not mixed; the live call creates
 * through the same service as the route. The service's SQL is proven in w6-fqd-freq-runs.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolContext } from '@/lib/mcp/types';

vi.mock('@/modules/accounting/services/payroll/payrollRunCreatePeriod', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/payrollRunCreatePeriod')>()),
  previewPeriodRun: vi.fn(),
  createPeriodRun: vi.fn(),
}));

import { createPayRunTool } from '@/lib/mcp/tools/writePayroll';
import { createPeriodRun, previewPeriodRun, PayrollRunOverlapError } from '@/modules/accounting/services/payroll/payrollRunCreatePeriod';
import { RunPeriodRefused, resolveRunPeriod, DEFAULT_PAY_WEEK } from '@/modules/accounting/services/payroll/payrollPayWeek';

const ctx: McpToolContext = {
  userId: 'u1', companyId: '22222222-2222-2222-2222-222222222222', scopes: ['write:payroll'], tokenJti: 'j', oauthAppId: null, companyRole: 'manager',
};
const KEY = { idempotency_key: 'k-1' };
const PERIOD = resolveRunPeriod('weekly', '2026-11-16', DEFAULT_PAY_WEEK);
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

beforeEach(() => {
  vi.mocked(previewPeriodRun).mockReset().mockResolvedValue({ period: PERIOD, refusal: null });
  vi.mocked(createPeriodRun).mockReset().mockResolvedValue({
    id: 'run-1', payFrequency: 'weekly', periodStart: PERIOD.periodStart, periodEnd: PERIOD.periodEnd, periodMonth: 11, periodYear: 2026, status: 'draft',
  } as Awaited<ReturnType<typeof createPeriodRun>>);
});

describe('create_pay_run, weekly and fortnightly', () => {
  it('a dry run returns the period and writes nothing', async () => {
    const res = await createPayRunTool.handler({ frequency: 'weekly', period_start: '2026-11-16', dry_run: true, ...KEY }, ctx);
    expect(res.wroteNothing).toBe(true);
    expect(body(res)).toMatchObject({ dryRun: true, skipped: [], period: { payDate: '2026-11-20' } });
    expect(createPeriodRun).not.toHaveBeenCalled();
  });

  it('the dry run reports the overlap the live call would refuse, and the live call refuses it unwritten', async () => {
    const refusal = new PayrollRunOverlapError('weekly', PERIOD, { start: '2026-11-14', end: '2026-11-20' });
    vi.mocked(previewPeriodRun).mockResolvedValue({ period: PERIOD, refusal });
    const dry = await createPayRunTool.handler({ frequency: 'weekly', period_start: '2026-11-16', dry_run: true, ...KEY }, ctx);
    expect(body(dry).skipped).toEqual([{ id: '2026-11-16', reason: 'period_overlap', detail: refusal.message }]);
    const live = await createPayRunTool.handler({ frequency: 'weekly', period_start: '2026-11-16', ...KEY }, ctx);
    expect([live.isError, live.content[0]!.text]).toEqual([true, expect.stringContaining('overlaps the run for 2026-11-14')]);
    expect(createPeriodRun).not.toHaveBeenCalled();
  });

  it('names a start off the pay week, and refuses month/year on a weekly run and period_start on a monthly one', async () => {
    vi.mocked(previewPeriodRun).mockRejectedValue(new RunPeriodRefused('A weekly period starts on a Monday.'));
    const off = await createPayRunTool.handler({ frequency: 'weekly', period_start: '2026-11-17', ...KEY }, ctx);
    expect([off.isError, off.content[0]!.text]).toEqual([true, expect.stringContaining('starts on a Monday')]);
    const mixed = await createPayRunTool.handler({ frequency: 'weekly', period_start: '2026-11-16', month: 11, year: 2026, ...KEY }, ctx);
    expect(mixed.isError).toBe(true);
    const monthly = await createPayRunTool.handler({ month: 11, year: 2026, period_start: '2026-11-16', ...KEY }, ctx);
    expect(monthly.isError).toBe(true);
    expect((await createPayRunTool.handler({ frequency: 'daily', ...KEY }, ctx)).isError).toBe(true);
    expect(createPeriodRun).not.toHaveBeenCalled();
  });

  it('a live call creates the run through the route\'s service', async () => {
    const res = await createPayRunTool.handler({ frequency: 'weekly', period_start: '2026-11-16', ...KEY }, ctx);
    expect(vi.mocked(createPeriodRun).mock.calls[0]).toEqual([ctx.companyId, 'weekly', '2026-11-16', 'u1']);
    expect(body(res)).toMatchObject({ run_id: 'run-1', pay_frequency: 'weekly', period_start: '2026-11-16', pay_date: '2026-11-20' });
  });
});
