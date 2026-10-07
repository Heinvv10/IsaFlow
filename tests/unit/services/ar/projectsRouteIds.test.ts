/**
 * GET /api/accounting/projects?ids=… — the projects a document already names,
 * whatever the 200-row list returns (migration 870's line pickers). This
 * company's only; malformed ids are refused, never cast.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_r: unknown, error: string) => ({ kind: 'badRequest', error })),
  },
}));
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn(async () => [{ id: 'p' }]) }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import handler from '../../../../pages/api/accounting/projects';

const A = 'b1000000-0000-4000-8000-000000000250';
const get = (ids: string) => (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<{ kind: string }>)(
  { method: 'GET', query: { ids }, companyId: 'company-1' } as unknown as NextApiRequest, {} as NextApiResponse);

beforeEach(() => vi.clearAllMocks());

describe('projects?ids=', () => {
  it('reads exactly those ids, scoped to the company', async () => {
    expect(await get(`${A},not-a-uuid`)).toEqual({ kind: 'success', data: [{ id: 'p' }] });
    const call = sqlMock.mock.calls[0] as unknown as [readonly string[], ...unknown[]];
    expect(call[0].join('?')).toMatch(/p\.company_id = \?::UUID AND p\.id = ANY\(\?::UUID\[\]\)/);
    expect(call.slice(1)).toEqual(['company-1', [A]]);
  });

  it('refuses when no id is a uuid', async () => {
    expect((await get('x,y')).kind).toBe('badRequest');
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
