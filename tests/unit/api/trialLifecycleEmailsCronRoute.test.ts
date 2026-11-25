/**
 * POST /api/cron/trial-lifecycle-emails: runs only with the right X-Cron-Secret, never on GET, never
 * with CRON_SECRET unset; parses dry_run and clamps limit; a failed company answers 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runTrialLifecycleEmails } = vi.hoisted(() => ({
  runTrialLifecycleEmails: vi.fn(async () => ({ dryRun: true, enabled: false, limit: 50, due: 0, processed: 0, failed: 0, emailsSent: 0, perCompany: [] })),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/onboarding/services/trialLifecycle/runTrialLifecycleEmails', () => ({ runTrialLifecycleEmails }));

import cronRoute from '../../../pages/api/cron/trial-lifecycle-emails';

function res() {
  const r = { statusCode: 200, body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
  return r;
}
async function call(req: Record<string, unknown>) {
  const out = res();
  await (cronRoute as (q: unknown, s: unknown) => Promise<unknown>)({ headers: {}, socket: {}, query: {}, ...req }, out);
  return out;
}
const KEY = crypto.randomUUID();
const auth = { 'x-cron-secret': KEY };
beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = KEY; });

describe('/api/cron/trial-lifecycle-emails', () => {
  it('runs with the right secret, a live run with the default limit', async () => {
    const r = await call({ method: 'POST', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(runTrialLifecycleEmails).toHaveBeenCalledWith({ dryRun: false, limit: 50 });
  });
  it.each([[{}], [{ 'x-cron-secret': 'wrong' }], [{ 'x-cron-secret': `${KEY}x` }]])('refuses %j with 401 and runs nothing', async (headers) => {
    expect((await call({ method: 'POST', headers })).statusCode).toBe(401);
    expect(runTrialLifecycleEmails).not.toHaveBeenCalled();
  });
  it('GET is 405; an unset CRON_SECRET is 500; neither runs', async () => {
    expect((await call({ method: 'GET', headers: auth })).statusCode).toBe(405);
    delete process.env.CRON_SECRET;
    expect((await call({ method: 'POST', headers: { 'x-cron-secret': '' } })).statusCode).toBe(500);
    expect(runTrialLifecycleEmails).not.toHaveBeenCalled();
  });
  it.each([
    [{ dry_run: '1', limit: '5' }, { dryRun: true, limit: 5 }],
    [{ dry_run: 'true', limit: '9999' }, { dryRun: true, limit: 200 }],
    [{ dry_run: '0', limit: '0' }, { dryRun: false, limit: 1 }],
    [{ limit: 'abc' }, { dryRun: false, limit: 50 }],
  ])('query %j runs with %j', async (query, expected) => {
    await call({ method: 'POST', headers: auth, query });
    expect(runTrialLifecycleEmails).toHaveBeenCalledWith(expected);
  });
  it('a run where any company failed answers 500 with every company\'s result', async () => {
    runTrialLifecycleEmails.mockResolvedValueOnce({ dryRun: false, enabled: true, limit: 50, due: 2, processed: 2, failed: 1, emailsSent: 1,
      perCompany: [{ companyId: 'a', stage: 'ended', action: 'failed', recipients: 0 }, { companyId: 'b', stage: 'check_in', action: 'sent', recipients: 1 }] } as never);
    const r = await call({ method: 'POST', headers: auth });
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).toContain('"companyId":"b"');
    expect(JSON.stringify(r.body)).toContain('1 of 2 companies failed');
  });
});
