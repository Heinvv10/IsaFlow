/**
 * POST /api/cron/health-alerts (admin audit OP-1): the 5-minute health-alert run starts only with
 * the right X-Cron-Secret (timing-safe compare), never on GET, never when CRON_SECRET is unset. With
 * the secret it takes the snapshot on the platform_admin pool and calls checkAndAlert once with it.
 * A snapshot that fails answers 500 through the real withErrorHandler and alerts nothing.
 * The pool, the snapshot and alert delivery are mocked: no email or webhook leaves this test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ queries: [] as string[], snapshotError: null as Error | null }));
const SNAPSHOT = vi.hoisted(() => ({ overall_status: 'critical', checked_at: '2026-11-15T10:00:00.000Z' }));
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log: logs, apiLogger: logs, default: logs }));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
  getPlatformAdminPool: () => ({
    connect: async () => ({
      query: async (text: string) => { fx.queries.push(text); return { rows: [] }; },
      release: () => undefined,
    }),
  }),
}));
const { buildSystemHealth, checkAndAlert } = vi.hoisted(() => ({
  buildSystemHealth: vi.fn(async () => { if (fx.snapshotError) throw fx.snapshotError; return SNAPSHOT; }),
  checkAndAlert: vi.fn(async () => undefined),
}));
vi.mock('@/modules/admin/services/systemHealthService', () => ({ buildSystemHealth }));
vi.mock('@/modules/admin/services/healthAlertService', () => ({ checkAndAlert }));
const recordScheduledRun = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/modules/admin/services/healthAlertState', () => ({ recordScheduledRun }));

import cronRoute from '../../../pages/api/cron/health-alerts';

function res() {
  const r = { statusCode: 200, body: undefined as unknown, headersSent: false,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; },
    setHeader() { return r; }, getHeader() { return undefined; }, on() { return r; } };
  return r;
}
async function call(req: Record<string, unknown>) {
  const out = res();
  await (cronRoute as (q: unknown, s: unknown) => Promise<unknown>)(
    { headers: {}, socket: {}, url: '/api/cron/health-alerts', query: {}, ...req }, out);
  return out;
}
const KEY = crypto.randomUUID();
beforeEach(() => {
  vi.clearAllMocks();
  fx.queries = [];
  fx.snapshotError = null;
  process.env.CRON_SECRET = KEY;
});

describe('/api/cron/health-alerts', () => {
  it('with the right secret: snapshots on the platform_admin pool and calls checkAndAlert once with it', async () => {
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ data: { overall_status: 'critical' } });
    expect(buildSystemHealth).toHaveBeenCalledTimes(1);
    expect(fx.queries).toEqual(['BEGIN READ ONLY', 'COMMIT']);
    expect(checkAndAlert).toHaveBeenCalledTimes(1);
    expect(checkAndAlert).toHaveBeenCalledWith(SNAPSHOT);
    expect(recordScheduledRun).toHaveBeenCalledTimes(1);
  });

  it('an alert that reached no channel answers 500 and does not record the run', async () => {
    checkAndAlert.mockRejectedValueOnce(new Error('Health alert (critical) reached no channel'));
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(500);
    expect(recordScheduledRun).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ 'x-cron-secret': 'wrong' }], [{ 'x-cron-secret': `${KEY}x` }]])(
    'refuses %j with 401 and runs nothing', async (headers) => {
      expect((await call({ method: 'POST', headers })).statusCode).toBe(401);
      expect(buildSystemHealth).not.toHaveBeenCalled();
      expect(checkAndAlert).not.toHaveBeenCalled();
      expect(recordScheduledRun).not.toHaveBeenCalled();
    });

  it('a snapshot that fails answers 500, rolls back and alerts nothing', async () => {
    fx.snapshotError = new Error('relation "background_jobs" does not exist');
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(500);
    expect(fx.queries).toEqual(['BEGIN READ ONLY', 'ROLLBACK']);
    expect(checkAndAlert).not.toHaveBeenCalled();
    expect(recordScheduledRun).not.toHaveBeenCalled();
  });

  it('GET is 405; an unset CRON_SECRET is 500; neither runs', async () => {
    expect((await call({ method: 'GET', headers: { 'x-cron-secret': KEY } })).statusCode).toBe(405);
    delete process.env.CRON_SECRET;
    expect((await call({ method: 'POST', headers: { 'x-cron-secret': '' } })).statusCode).toBe(500);
    expect(buildSystemHealth).not.toHaveBeenCalled();
    expect(checkAndAlert).not.toHaveBeenCalled();
  });
});
