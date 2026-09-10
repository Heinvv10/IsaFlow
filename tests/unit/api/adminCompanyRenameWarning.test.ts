// tests/unit/api/adminCompanyRenameWarning.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn(async () => undefined) }));
vi.mock('@/utils/getIp', () => ({ getIp: () => '127.0.0.1' }));
const updateCompany = vi.fn(async () => undefined);
vi.mock('@/modules/admin/services/adminCompanyService', () => ({
  getCompanyDetail: vi.fn(async () => ({ id: 'c1', name: 'New Name' })),
  updateCompany: (...a: unknown[]) => updateCompany(...(a as [])),
  deleteCompany: vi.fn(),
}));
// Which documents a write voids is decided by their fingerprints, in afsSigningIntegrity, and
// proven against PostgreSQL in afsSigningInputsHttp.int.test.ts. This file proves the admin
// rename runs its write THROUGH that check and returns what it reports.
const impact = vi.fn();
vi.mock('@/modules/accounting/services/afs/afsSigningIntegrity', () => ({
  withSignatureImpactWarnings: (...a: unknown[]) => impact(...a),
}));
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
const run = (body: Record<string, unknown>, r: ReturnType<typeof res>) =>
  (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(patch(body), r);

describe('admin company PATCH and documents out for signature', () => {
  beforeEach(() => { impact.mockReset(); updateCompany.mockClear(); });

  it('makes the update inside the fingerprint check and returns the signatures it voided', async () => {
    impact.mockImplementation(async (_q: unknown, companyId: unknown, write: () => Promise<unknown>) =>
      ({ result: await write(), warnings: [`AFS document d1 of ${String(companyId)} is out for signature`] }));
    const r = res();
    await run({ name: 'New Name' }, r);
    expect(updateCompany, 'the rename happened outside the check').toHaveBeenCalledTimes(1);
    expect(r.body.data?.warnings, 'an admin rename voided a signature silently').toEqual([`AFS document d1 of ${COMPANY} is out for signature`]);
  });

  it('returns no warning when the check finds nothing signed changed', async () => {
    impact.mockImplementation(async (_q: unknown, _c: unknown, write: () => Promise<unknown>) => ({ result: await write(), warnings: [] }));
    const r = res();
    await run({ phone: '0110000000' }, r);
    expect(r.body.data?.warnings).toEqual([]);
  });
});
