/**
 * Routes that mix payroll into a company-wide answer: each asks mayReadPayroll for the SESSION's company and user and hands
 * the answer to its service as a required `payrollRead`. A request with no user or company is refused before any read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  pass: (x: unknown) => x,
  attention: vi.fn(), setup: vi.fn(), answer: vi.fn(), may: vi.fn(), sql: vi.fn(), completeness: vi.fn(), checklist: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ withAuth: h.pass, withWriteAccess: h.pass }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: h.pass }));
vi.mock('@/lib/auth/payrollReadGate', () => ({ mayReadPayroll: h.may }));
vi.mock('@/lib/apiResponse', () => ({ apiResponse: { success: vi.fn(), forbidden: vi.fn(), badRequest: vi.fn(), methodNotAllowed: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: h.sql }));
vi.mock('@/lib/saDateParser', () => ({ todayInSast: () => '2026-11-13' }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => h.pass, markFlowNoOp: vi.fn() }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));
vi.mock('@/modules/accounting/services/dashboard/attentionService', () => ({ getAttentionList: h.attention }));
vi.mock('@/modules/accounting/services/core/setupProgressService', () => ({ getSetupProgress: h.setup }));
vi.mock('@/modules/accounting/services/ask/askAnswer', () => ({ answerQuestion: h.answer }));
vi.mock('@/modules/accounting/services/ask/askProvider', () => ({ resolveProvider: () => null }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ getFiscalYear: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/monthEndCloseService', () => ({
  generateCloseChecklist: h.checklist, checkCompleteness: h.completeness, buildCloseProgressSummary: () => ({ percentComplete: 0, period: 'p', status: 'not_started' }),
}));

import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: pages/ is outside src/
import attentionRoute from '../../../pages/api/accounting/dashboard/attention';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import setupRoute from '../../../pages/api/accounting/setup-checklist';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import askRoute from '../../../pages/api/accounting/ask';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import closeRoute from '../../../pages/api/accounting/month-end-close';

const CO = '11111111-1111-4111-9111-111111111111';
type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const res = { setHeader: vi.fn() } as unknown as NextApiResponse;
const req = (over: Record<string, unknown> = {}) => ({ method: 'GET', query: { q: 'emp201', companyId: 'other' }, companyId: CO, user: { id: 'caller' }, ...over }) as unknown as NextApiRequest;
const run = (route: unknown, r: NextApiRequest) => (route as Handler)(r, res);

beforeEach(() => {
  vi.clearAllMocks();
  h.attention.mockResolvedValue({ asAt: 'x', items: [] });
  h.setup.mockResolvedValue({ modules: [] });
  h.answer.mockResolvedValue({ figure: 1 });
  h.sql.mockResolvedValue([{ cnt: 0 }]);
  h.checklist.mockReturnValue([]);
  h.completeness.mockReturnValue({ complete: false, missing: [], percentComplete: 0 });
});

describe.each([[true], [false]])('payrollRead=%s', (allowed) => {
  beforeEach(() => h.may.mockResolvedValue(allowed));

  it('attention: the session company and user decide, and the service is told', async () => {
    await run(attentionRoute, req());
    expect(h.may).toHaveBeenCalledWith(CO, 'caller');
    expect(h.attention).toHaveBeenCalledWith(CO, { payrollRead: allowed });
  });
  it('setup-checklist: likewise', async () => {
    await run(setupRoute, req());
    expect(h.may).toHaveBeenCalledWith(CO, 'caller');
    expect(h.setup).toHaveBeenCalledWith(CO, { payrollRead: allowed });
  });
  it('ask: likewise', async () => {
    await run(askRoute, req());
    expect(h.may).toHaveBeenCalledWith(CO, 'caller');
    expect(h.answer.mock.calls[0]![3]).toEqual({ payrollRead: allowed });
  });
  it('month-end-close: no payroll query, no payroll checklist and no payroll check without read', async () => {
    await run(closeRoute, req({ query: {} }));
    expect(h.may).toHaveBeenCalledWith(CO, 'caller');
    expect(h.checklist).toHaveBeenCalledWith(allowed ? 'with_payroll' : 'without_payroll');
    expect(h.completeness.mock.calls[0]![1]).toEqual({ payroll: allowed });
    const payrollQueries = h.sql.mock.calls.filter(([strings]) => String(strings.join('')).includes('payroll_runs')).length;
    expect(payrollQueries).toBe(allowed ? 1 : 0);
  });
});

describe('no user in the session', () => {
  it.each([['attention', attentionRoute], ['setup-checklist', setupRoute], ['month-end-close', closeRoute]])('%s is refused before any read', async (_n, route) => {
    await run(route, req({ user: undefined, query: {} }));
    expect(apiResponse.forbidden).toHaveBeenCalled();
    expect(h.attention).not.toHaveBeenCalled();
    expect(h.setup).not.toHaveBeenCalled();
  });
  it('ask treats it as no Payroll read', async () => {
    await run(askRoute, req({ user: undefined }));
    expect(h.may).not.toHaveBeenCalled();
    expect(h.answer.mock.calls[0]![3]).toEqual({ payrollRead: false });
  });
});
