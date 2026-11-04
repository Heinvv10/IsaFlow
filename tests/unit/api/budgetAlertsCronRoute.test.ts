/**
 * POST /api/cron/budget-alerts (budgets P5-4): the run starts only with the right X-Cron-Secret
 * (timing-safe compare), never on GET, and never when CRON_SECRET is unset on the server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runBudgetAlertCron } = vi.hoisted(() => ({
  runBudgetAlertCron: vi.fn(async () => ({ asOf: '2026-04-20', companies: 0, failed: 0, fired: 0, resolved: 0, perCompany: [] })),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/budgets/budgetAlertCron', () => ({ runBudgetAlertCron }));

import cronRoute from '../../../pages/api/cron/budget-alerts';

function res() {
  const r = { statusCode: 200, body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
  return r;
}
async function call(req: Record<string, unknown>) {
  const out = res();
  await (cronRoute as (q: unknown, s: unknown) => Promise<unknown>)({ headers: {}, socket: {}, ...req }, out);
  return out;
}
const KEY = crypto.randomUUID();
beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = KEY; });

describe('/api/cron/budget-alerts', () => {
  it('runs with the right secret', async () => {
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(200);
    expect(runBudgetAlertCron).toHaveBeenCalledTimes(1);
  });
  it.each([[{}], [{ 'x-cron-secret': 'wrong' }], [{ 'x-cron-secret': `${KEY}x` }]])('refuses %j with 401 and runs nothing', async (headers) => {
    expect((await call({ method: 'POST', headers })).statusCode).toBe(401);
    expect(runBudgetAlertCron).not.toHaveBeenCalled();
  });
  it('a run where any company failed answers 500 (curl --fail and systemd see it), with every company\'s result', async () => {
    const result = { asOf: '2026-04-20', companies: 2, failed: 1, fired: 1, resolved: 0,
      perCompany: [{ companyId: 'a', ok: false, fired: 0, resolved: 0, error: 'evaluation failed; see logs' },
        { companyId: 'b', ok: true, fired: 1, resolved: 0 }] };
    runBudgetAlertCron.mockResolvedValueOnce(result as never);
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).toContain('"companyId":"b"');
    expect(JSON.stringify(r.body)).toContain('1 of 2 companies failed');
  });
  it('GET is 405; an unset CRON_SECRET is 500; neither runs', async () => {
    expect((await call({ method: 'GET', headers: { 'x-cron-secret': KEY } })).statusCode).toBe(405);
    delete process.env.CRON_SECRET;
    expect((await call({ method: 'POST', headers: { 'x-cron-secret': '' } })).statusCode).toBe(500);
    expect(runBudgetAlertCron).not.toHaveBeenCalled();
  });
});
