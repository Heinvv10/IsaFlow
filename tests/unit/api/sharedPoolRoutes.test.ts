/**
 * Shared-pool routes: the mapping route scopes to req.companyId and validates its input; the cron route
 * runs the job only with the right X-Cron-Secret; the admin route queues the job after commit, never
 * inline on the request's connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveCategoryMapping, autoMapCategories, listCategoryMappings, runSharedPoolAggregation, runAfterCommit } = vi.hoisted(() => ({
  saveCategoryMapping: vi.fn(async () => undefined),
  autoMapCategories: vi.fn(async () => ({ mapped: 1, ambiguous: [] })),
  listCategoryMappings: vi.fn(async () => ({ listVersion: 1, categories: [] })),
  runSharedPoolAggregation: vi.fn(async () => ({ published: 3 })),
  runAfterCommit: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit }));
vi.mock('@/modules/accounting/services/sharedPool/sharedPoolJob', () => ({ runSharedPoolAggregation }));
vi.mock('@/modules/accounting/services/sharedPool/categoryMappingService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/sharedPool/categoryMappingService')>()),
  saveCategoryMapping, autoMapCategories, listCategoryMappings,
}));

import mappingRoute from '../../../pages/api/accounting/category-mappings';
import cronRoute from '../../../pages/api/cron/shared-merchant-pool';
import adminRoute from '../../../pages/api/admin/shared-merchant-pool';

const CO = '00000000-0000-4000-8000-000000000001';
const GL = '00000000-0000-4000-8000-0000000000aa';

function res() {
  const r = { statusCode: 200, body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
  return r;
}
async function call(route: unknown, req: Record<string, unknown>) {
  const out = res();
  await (route as (q: unknown, s: unknown) => Promise<unknown>)({ headers: {}, socket: {}, ...req }, out);
  return out;
}
const asCompany = { companyId: CO, user: { id: 'user-1' } };

// A random key per run, as the r168 cron suites do.
const CRON_KEY = crypto.randomUUID();
beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = CRON_KEY; });

describe('/api/accounting/category-mappings', () => {
  it('GET lists for req.companyId only', async () => {
    await call(mappingRoute, { ...asCompany, method: 'GET', query: { companyId: 'someone-else' } });
    expect(listCategoryMappings).toHaveBeenCalledWith(CO);
  });
  it('save passes the company, the user and the pick', async () => {
    const r = await call(mappingRoute, { ...asCompany, method: 'POST', body: { action: 'save', categoryCode: 'fuel', glAccountId: GL } });
    expect(r.statusCode).toBe(200);
    expect(saveCategoryMapping).toHaveBeenCalledWith(CO, 'user-1', 'fuel', GL);
  });
  it('save with null clears; a non-uuid account is a 422 and writes nothing', async () => {
    await call(mappingRoute, { ...asCompany, method: 'POST', body: { action: 'save', categoryCode: 'fuel', glAccountId: null } });
    expect(saveCategoryMapping).toHaveBeenLastCalledWith(CO, 'user-1', 'fuel', null);
    const r = await call(mappingRoute, { ...asCompany, method: 'POST', body: { action: 'save', categoryCode: 'fuel', glAccountId: 'x' } });
    expect(r.statusCode).toBe(422);
    expect(saveCategoryMapping).toHaveBeenCalledTimes(1);
  });
  it('an unknown category is refused by the service as a 400', async () => {
    const { CategoryMappingRefusal } = await import('@/modules/accounting/services/sharedPool/categoryMappingService');
    saveCategoryMapping.mockRejectedValueOnce(new CategoryMappingRefusal('Unknown category: x'));
    const r = await call(mappingRoute, { ...asCompany, method: 'POST', body: { action: 'save', categoryCode: 'x', glAccountId: GL } });
    expect(r.statusCode).toBe(400);
  });
  it('auto_map runs for req.companyId', async () => {
    await call(mappingRoute, { ...asCompany, method: 'POST', body: { action: 'auto_map' } });
    expect(autoMapCategories).toHaveBeenCalledWith(CO, 'user-1');
  });
});

describe('/api/cron/shared-merchant-pool', () => {
  it('a wrong or missing secret is 401 and runs nothing', async () => {
    for (const headers of [{}, { 'x-cron-secret': 'nope' }]) {
      const r = await call(cronRoute, { method: 'POST', headers });
      expect(r.statusCode).toBe(401);
    }
    expect(runSharedPoolAggregation).not.toHaveBeenCalled();
  });
  it('the right secret runs the job once', async () => {
    const r = await call(cronRoute, { method: 'POST', headers: { 'x-cron-secret': CRON_KEY } });
    expect(r.statusCode).toBe(200);
    expect(runSharedPoolAggregation).toHaveBeenCalledTimes(1);
  });
  it('GET is not allowed', async () => {
    expect((await call(cronRoute, { method: 'GET', headers: { 'x-cron-secret': CRON_KEY } })).statusCode).toBe(405);
  });
});

describe('/api/admin/shared-merchant-pool', () => {
  it('queues the job after commit (never inline)', async () => {
    const r = await call(adminRoute, { method: 'POST', body: { action: 'recompute' }, user: { id: 'admin-1' } });
    expect(r.statusCode).toBe(200);
    expect(runSharedPoolAggregation).not.toHaveBeenCalled();
    expect(runAfterCommit).toHaveBeenCalledWith('shared-merchant-pool: admin recompute', runSharedPoolAggregation);
  });
  it('anything but { action: recompute } is a 400', async () => {
    expect((await call(adminRoute, { method: 'POST', body: { action: 'recompute', extra: 1 }, user: { id: 'a' } })).statusCode).toBe(400);
    expect(runAfterCommit).not.toHaveBeenCalled();
  });
});
