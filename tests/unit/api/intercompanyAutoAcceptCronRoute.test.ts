/**
 * POST /api/cron/intercompany-auto-accept (intercompany P2): the run starts only with the right X-Cron-Secret (timing-safe
 * compare), never on GET, and never when CRON_SECRET is unset on the server; a run where a message failed answers 500 so the
 * timer's curl --fail reports it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runAutoAccept } = vi.hoisted(() => ({
  runAutoAccept: vi.fn(async () => ({ considered: 0, accepted: 0, failed: 0, deferred: 0, stuck: 0, exhausted: 0 })),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/intercompany/autoAcceptWorker', () => ({ runAutoAccept }));

import cronRoute from '../../../pages/api/cron/intercompany-auto-accept';

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

describe('/api/cron/intercompany-auto-accept', () => {
  it('runs with the right secret', async () => {
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(200);
    expect(runAutoAccept).toHaveBeenCalledTimes(1);
  });
  it.each([[{}], [{ 'x-cron-secret': 'wrong' }], [{ 'x-cron-secret': `${KEY}x` }]])('refuses %j with 401 and runs nothing', async (headers) => {
    expect((await call({ method: 'POST', headers })).statusCode).toBe(401);
    expect(runAutoAccept).not.toHaveBeenCalled();
  });
  it('a run where a message failed answers 500 with the counts', async () => {
    runAutoAccept.mockResolvedValueOnce({ considered: 3, accepted: 2, failed: 1, deferred: 0, stuck: 0, exhausted: 0 });
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).toContain('1 of 3 messages failed');
  });
  it('a message that keeps deferring (stuck) is a 500 too, so a persistent fault is reported; one deferral that is not stuck is not', async () => {
    runAutoAccept.mockResolvedValueOnce({ considered: 2, accepted: 1, failed: 0, deferred: 1, stuck: 1, exhausted: 0 });
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).toContain('1 stuck (0 out of attempts)');
    runAutoAccept.mockResolvedValueOnce({ considered: 2, accepted: 1, failed: 0, deferred: 1, stuck: 0, exhausted: 0 });
    expect((await call({ method: 'POST', headers: { 'x-cron-secret': KEY } })).statusCode).toBe(200);
  });
  it('a message that used all its attempts (the queue let go of it: it sits pending for a person) is in the stuck figure, so the timer reports it', async () => {
    runAutoAccept.mockResolvedValueOnce({ considered: 0, accepted: 0, failed: 0, deferred: 0, stuck: 2, exhausted: 2 });
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).toContain('2 stuck (2 out of attempts)');
  });
  it('GET is 405; an unset CRON_SECRET is 500; neither runs', async () => {
    expect((await call({ method: 'GET', headers: { 'x-cron-secret': KEY } })).statusCode).toBe(405);
    delete process.env.CRON_SECRET;
    expect((await call({ method: 'POST', headers: { 'x-cron-secret': '' } })).statusCode).toBe(500);
    expect(runAutoAccept).not.toHaveBeenCalled();
  });
});
