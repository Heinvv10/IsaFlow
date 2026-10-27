import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const searchMock = vi.fn();
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/globalSearchService', () => ({
  globalSearch: (...a: unknown[]) => searchMock(...a),
}));

import handler from '../../../pages/api/accounting/global-search';

function call(q: string) {
  const res = { statusCode: 0, body: undefined as unknown } as { statusCode: number; body: unknown };
  const r = {
    status(c: number) { res.statusCode = c; return r; },
    json(b: unknown) { res.body = b; return r; },
    setHeader() { return r; },
    end() { return r; },
  };
  const req = { method: 'GET', query: { q }, companyId: 'c1' } as unknown as NextApiRequest;
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, r as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => { searchMock.mockReset(); searchMock.mockResolvedValue([]); });

describe('GET /api/accounting/global-search query length', () => {
  it('a query over 100 characters is a 400 and never reaches the database', async () => {
    const res = await call('a'.repeat(101));
    expect(res.statusCode).toBe(400);
    expect(searchMock).not.toHaveBeenCalled();
  });
  it('100 characters still searches', async () => {
    const res = await call('a'.repeat(100));
    expect(res.statusCode).toBe(200);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });
});
