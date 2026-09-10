// tests/unit/api/adminCompanyRenameWarning.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn(async () => undefined) }));
vi.mock('@/utils/getIp', () => ({ getIp: () => '127.0.0.1' }));
const detail = vi.fn();
vi.mock('@/modules/admin/services/adminCompanyService', () => ({
  getCompanyDetail: (...a: unknown[]) => detail(...a),
  updateCompany: vi.fn(async () => undefined),
  deleteCompany: vi.fn(),
}));
// The warning's own query is proven against PostgreSQL in afsSigningInputsHttp.int.test.ts;
// this file proves the admin rename path asks for it, and only when the name changes.
const warnings = vi.fn(async () => ['AFS document d1 (2024) is out for signature: this change will void it.']);
vi.mock('@/modules/accounting/services/afs/afsSigningIntegrity', () => ({ signingInvalidationWarnings: (...a: unknown[]) => warnings(...a) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import handler from '../../../pages/api/admin/companies/[id]';

const COMPANY = '11111111-1111-4111-9111-111111111111';
function patch(body: Record<string, unknown>) {
  return { method: 'PATCH', query: { id: COMPANY }, body, user: { id: 'admin' }, headers: {} } as unknown as NextApiRequest;
}
function res() {
  const r = { statusCode: 200, body: undefined as unknown, status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; }, setHeader: vi.fn(), end: vi.fn() };
  return r as unknown as NextApiResponse & { statusCode: number; body: { data?: { warnings?: string[] } } };
}

describe('admin company PATCH and documents out for signature', () => {
  beforeEach(() => { detail.mockReset(); warnings.mockClear(); });

  it('warns which signatures a rename will void', async () => {
    detail.mockResolvedValueOnce({ id: COMPANY, name: 'Old Name' }).mockResolvedValueOnce({ id: COMPANY, name: 'New Name' });
    const r = res();
    await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(patch({ name: 'New Name' }), r);
    expect(r.body.data?.warnings, 'an admin rename voided a signature silently').toHaveLength(1);
  });

  it('does not warn when the registered name is unchanged', async () => {
    detail.mockResolvedValue({ id: COMPANY, name: 'Same Name' });
    const r = res();
    await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(patch({ name: 'Same Name', phone: '0110000000' }), r);
    expect(r.body.data?.warnings).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
  });
});
