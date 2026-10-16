// PUT /api/accounting/companies refuses an entityType outside the eight SA codes
// with a 400 before any write (it used to reach the DB CHECK as a 500), and
// passes each of the eight through to updateCompany.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const updateCompany = vi.hoisted(() => vi.fn(async (id: string, u: unknown) => ({ id, ...(u as object) })));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({
  getCompany: vi.fn(), createCompany: vi.fn(), setDefaultCompany: vi.fn(), updateCompany,
  getUserCompanies: vi.fn(async () => [{ companyId: 'c1', role: 'owner' }]),
}));
import handler from '../../../pages/api/accounting/companies';
import { ENTITY_TYPE_CODES } from '@/lib/entityTypes';

async function put(body: Record<string, unknown>) {
  const out = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; },
    setHeader() { return this; }, end() { return this; } };
  await (handler as unknown as (q: unknown, r: unknown) => Promise<void>)(
    { method: 'PUT', body, query: {}, user: { id: 'u1' }, headers: {} }, res);
  return out;
}
beforeEach(() => updateCompany.mockClear());

describe('PUT /api/accounting/companies entityType edges', () => {
  it.each(['', 'pty', 'company', 'Pty_Ltd', ' cc', 'cc ', null, 5, {}, []])('rejects %j with 400, no write', async v => {
    const r = await put({ id: 'c1', entityType: v });
    expect(r.status).toBe(400);
    expect(updateCompany).not.toHaveBeenCalled();
  });
  it.each([...ENTITY_TYPE_CODES])('passes %s through to updateCompany', async code => {
    expect((await put({ id: 'c1', entityType: code })).status).toBe(200);
    expect(updateCompany).toHaveBeenCalledWith('c1', { entityType: code });
  });
  it('an omitted entityType is not validated', async () => {
    expect((await put({ id: 'c1', name: 'x' })).status).toBe(200);
  });
});
