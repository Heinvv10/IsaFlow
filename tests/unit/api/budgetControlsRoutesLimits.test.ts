/**
 * The budget controls write routes (P5-4 review r2) are rate-limited per user: 60 writes a minute,
 * one bucket for settings and threshold overrides (429 with Retry-After, the service never called).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkRateLimit, saveControlSettings, upsertThresholdOverride, deleteThresholdOverride, readControlsView } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async () => false),
  saveControlSettings: vi.fn(async () => undefined),
  upsertThresholdOverride: vi.fn(async () => ({})),
  deleteThresholdOverride: vi.fn(async () => undefined),
  readControlsView: vi.fn(async () => ({})),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h, DEFAULT_WRITE_ROLES: ['owner', 'admin', 'manager'] }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit }));
vi.mock('@/modules/accounting/services/budgets/budgetControlSettings', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/budgets/budgetControlSettings')>()),
  saveControlSettings, upsertThresholdOverride, deleteThresholdOverride,
}));
vi.mock('@/modules/accounting/services/budgets/budgetControlsApi', () => ({ readControlsView }));

import controlsRoute from '../../../pages/api/accounting/budgets/controls/index';
import thresholdsRoute from '../../../pages/api/accounting/budgets/controls/thresholds';

const CO = '00000000-0000-4000-8000-000000000001';
const ACC = '00000000-0000-4000-8000-0000000000aa';

function res() {
  const headers: Record<string, string> = {};
  const r = { statusCode: 200, body: undefined as unknown, headers,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; },
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; return r; } };
  return r;
}
async function call(route: unknown, req: Record<string, unknown>) {
  const out = res();
  await (route as (q: unknown, s: unknown) => Promise<unknown>)({ headers: {}, socket: {}, companyId: CO, companyRole: 'owner', user: { id: 'user-1' }, query: {}, ...req }, out);
  return out;
}
beforeEach(() => { vi.clearAllMocks(); checkRateLimit.mockResolvedValue(false); });

describe('budget controls writes are rate-limited per user', () => {
  it.each([
    ['PUT controls', controlsRoute, { method: 'PUT', body: { checkPolicy: 'block' } }],
    ['POST threshold', thresholdsRoute, { method: 'POST', body: { glAccountId: ACC, thresholds: [90] } }],
    ['DELETE threshold', thresholdsRoute, { method: 'DELETE', body: { id: ACC } }],
  ] as const)('%s: over the limit is 429 and writes nothing', async (_n, route, req) => {
    const r = await call(route, req);
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('60');
    expect(checkRateLimit).toHaveBeenCalledWith('budget-controls-write:user-1', { max: 60, windowSecs: 60 });
    expect(saveControlSettings).not.toHaveBeenCalled();
    expect(upsertThresholdOverride).not.toHaveBeenCalled();
    expect(deleteThresholdOverride).not.toHaveBeenCalled();
  });

  it('a GET is not charged', async () => {
    const r = await call(controlsRoute, { method: 'GET' });
    expect(r.statusCode).toBe(200);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
