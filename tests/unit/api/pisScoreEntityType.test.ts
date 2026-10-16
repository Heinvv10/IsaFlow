// PUT /api/accounting/afs/pis-score writes companies.entity_type, so its
// optional entityType takes the eight SA codes (migration 894's CHECK), not
// the old AFS keys: 'pty' is refused (422, zod validation) before any write.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => vi.fn(async () => []));
vi.mock('@/lib/neon', () => ({ sql }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/afs/pisCalculatorService', () => ({ computePisBreakdown: vi.fn() }));
// The new type's proof check reads the DB (tests/integration/onboarding-complete-setup-guards.int.test.ts); mocked here.
const assertChange = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/modules/onboarding/services/entityTypeChange', async (orig) => ({
  ...(await orig<typeof import('@/modules/onboarding/services/entityTypeChange')>()), assertEntityTypeChangeAllowed: assertChange,
}));
import handler from '../../../pages/api/accounting/afs/pis-score';
import { ENTITY_TYPE_CODES } from '@/lib/entityTypes';
import { EntityTypeChangeRefused } from '@/modules/onboarding/services/entityTypeChange';

async function put(body: Record<string, unknown>) {
  const out = { status: 0 };
  const res = { status(c: number) { out.status = c; return this; }, json() { return this; },
    setHeader() { return this; }, end() { return this; } };
  await (handler as unknown as (q: unknown, r: unknown) => Promise<void>)(
    { method: 'PUT', body, query: {}, companyId: 'c1', user: { id: 'u1' }, headers: {} }, res);
  return out;
}
beforeEach(() => { sql.mockClear(); assertChange.mockClear(); });

describe('PIS PUT entityType', () => {
  it.each([...ENTITY_TYPE_CODES])('accepts %s and writes it', async code => {
    expect((await put({ entityType: code })).status).toBe(200);
    expect(sql).toHaveBeenCalledTimes(1);
    expect((sql.mock.calls[0] as unknown[]).slice(1)).toContain(code);
    expect(assertChange).toHaveBeenCalledWith('c1', code);
  });
  it('a type the stored proof does not support: 400 and nothing written', async () => {
    assertChange.mockRejectedValueOnce(new EntityTypeChangeRefused(['Upload the CK1 or CK2']));
    expect((await put({ entityType: 'cc' })).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
  it.each(['pty', 'company', 'bogus'])('refuses %s (422) and writes nothing', async v => {
    expect((await put({ entityType: v })).status).toBe(422);
    expect(sql).not.toHaveBeenCalled();
  });
});
