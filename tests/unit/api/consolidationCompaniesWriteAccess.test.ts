/**
 * D4 round 8: consolidation/companies POST (attach a subsidiary) and DELETE (withdraw one)
 * change the ACTIVE company's group, which consolidation/trial-balance then aggregates. They were
 * gated by withAuth only, so a viewer could change them. The route is now wrapped in the real
 * withWriteAccess: a viewer gets 403 before anything is written; GET still reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const rel = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ id: 'child' }]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({ userCanWriteCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/reports/consolidationService', () => ({
  getGroupCompanies: rel.list, createCompanyRelationship: rel.create, deleteCompanyRelationship: rel.remove,
}));

import handler from '../../../pages/api/accounting/consolidation/companies';

const CHILD = '10000000-0000-4000-8000-0000000000a2';

async function call(method: string, companyRole: string, extra: Record<string, unknown> = {}) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(
    { method, companyId: 'parent', companyRole, user: { id: 'u1' }, query: {}, body: { childCompanyId: CHILD }, ...extra } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}

beforeEach(() => {
  rel.create.mockReset().mockResolvedValue(undefined);
  rel.remove.mockReset().mockResolvedValue(true);
  rel.list.mockReset().mockResolvedValue([]);
});

describe('consolidation/companies write access', () => {
  it.each(['POST', 'DELETE'])('%s by a viewer → 403, nothing written', async (method) => {
    const res = await call(method, 'viewer');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(rel.create).not.toHaveBeenCalled();
    expect(rel.remove).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin', 'manager'])('POST and DELETE by a %s are allowed', async (role) => {
    expect((await call('POST', role)).status).toHaveBeenCalledWith(200);
    expect((await call('DELETE', role)).status).toHaveBeenCalledWith(200);
    expect(rel.create).toHaveBeenCalledTimes(1);
    expect(rel.remove).toHaveBeenCalledTimes(1);
  });

  it('GET by a viewer still reads', async () => {
    expect((await call('GET', 'viewer')).status).toHaveBeenCalledWith(200);
  });
});
