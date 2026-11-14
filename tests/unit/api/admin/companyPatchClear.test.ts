/**
 * Company edit through the real PATCH schema (WP13 review M3, audit 4.17): null clears an optional field, an absent
 * key is left as it is, the name can never be cleared. Contract for '': the free-text fields accept it and the
 * service stores NULL (pinned in tests/integration/admin-screens-wp13.int.test.ts); Email and Website must be a
 * valid value or null, so '' is 400 there (the page sends null for a blanked field).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const updateCompany = vi.fn(async (_id: string, _data: Record<string, unknown>) => undefined);
vi.mock('@/modules/admin/services/adminCompanyService', () => ({
  updateCompany: (id: string, data: Record<string, unknown>) => updateCompany(id, data),
  getCompanyDetail: vi.fn(async () => ({ id: 'x', name: 'Acme' })),
}));
vi.mock('@/modules/admin/services/companyLifecycleService', () => ({ deleteCompany: vi.fn() }));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn(async () => undefined) }));

import route from '../../../../pages/api/admin/companies/[id]';
import { callRoute } from '../../helpers/adminRouteCall';

const ID = '00000000-0000-4000-8000-0000000c0714';
const CLEARABLE = ['trading_name', 'phone', 'email', 'website', 'billing_email', 'billing_contact',
  'address_line1', 'city', 'province', 'postal_code'] as const;
const FREE_TEXT = ['trading_name', 'phone', 'billing_contact', 'address_line1', 'city', 'province', 'postal_code'] as const;
const patch = (body: unknown) => callRoute(route, 'PATCH', { id: ID }, body);
const sent = () => updateCompany.mock.calls[0]![1];

beforeEach(() => { vi.clearAllMocks(); });

describe('PATCH /api/admin/companies/[id] clearing fields', () => {
  it.each(CLEARABLE)('%s: null reaches the service as null (clears it)', async (key) => {
    const r = await patch({ [key]: null });
    expect(r.statusCode).toBe(200);
    expect(sent()[key]).toBeNull();
  });

  it.each(CLEARABLE)('%s: absent stays undefined (kept)', async (key) => {
    const other = key === 'city' ? 'phone' : 'city';
    expect((await patch({ [other]: null })).statusCode).toBe(200);
    expect(sent()[key]).toBeUndefined();
  });

  it.each(FREE_TEXT)("%s: '' is accepted (the service stores NULL)", async (key) => {
    expect((await patch({ [key]: '' })).statusCode).toBe(200);
    expect(sent()[key]).toBe('');
  });

  it.each(['email', 'website', 'billing_email'])("%s: '' is 400", async (key) => {
    expect((await patch({ [key]: '' })).statusCode).toBe(400);
    expect(updateCompany).not.toHaveBeenCalled();
  });

  it.each([[{ name: null }], [{ name: '' }]])('%j is 400: a company always has a name', async (body) => {
    expect((await patch(body)).statusCode).toBe(400);
    expect(updateCompany).not.toHaveBeenCalled();
  });
});
