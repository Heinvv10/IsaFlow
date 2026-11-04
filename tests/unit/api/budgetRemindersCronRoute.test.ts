/**
 * POST /api/cron/budget-reminders (budgets P5-6): the run starts only with the right X-Cron-Secret
 * (timing-safe compare), never on GET, and never when CRON_SECRET is unset on the server; a run where
 * a company failed answers 500 so the timer's curl --fail reports it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runSliceReminderCron } = vi.hoisted(() => ({
  runSliceReminderCron: vi.fn(async () => ({ asOf: '2030-05-10', companies: 0, failed: 0, reminded: 0, perCompany: [] })),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/budgets/sliceReminders', () => ({ runSliceReminderCron }));

import cronRoute from '../../../pages/api/cron/budget-reminders';

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

describe('/api/cron/budget-reminders', () => {
  it('runs with the right secret', async () => {
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(200);
    expect(runSliceReminderCron).toHaveBeenCalledTimes(1);
  });
  it.each([[{}], [{ 'x-cron-secret': 'wrong' }], [{ 'x-cron-secret': `${KEY}x` }]])('refuses %j with 401 and runs nothing', async (headers) => {
    expect((await call({ method: 'POST', headers })).statusCode).toBe(401);
    expect(runSliceReminderCron).not.toHaveBeenCalled();
  });
  it('a run where any company failed answers 500 with every company\'s result', async () => {
    runSliceReminderCron.mockResolvedValueOnce({ asOf: '2030-05-10', companies: 2, failed: 1, reminded: 1,
      perCompany: [{ companyId: 'a', ok: false, reminded: 0, error: 'reminders failed; see logs' }, { companyId: 'b', ok: true, reminded: 1 }] } as never);
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).toContain('1 of 2 companies failed');
  });
  it('GET is 405; an unset CRON_SECRET is 500; neither runs', async () => {
    expect((await call({ method: 'GET', headers: { 'x-cron-secret': KEY } })).statusCode).toBe(405);
    delete process.env.CRON_SECRET;
    expect((await call({ method: 'POST', headers: { 'x-cron-secret': '' } })).statusCode).toBe(500);
    expect(runSliceReminderCron).not.toHaveBeenCalled();
  });
});
