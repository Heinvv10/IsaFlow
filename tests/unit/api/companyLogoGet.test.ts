// GET /api/accounting/company-logo serves a logo only for a live company the caller belongs to,
// and only bytes that really are the declared safe raster type (the company switcher loads one per row).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ sql: vi.fn(), isLive: vi.fn() }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/auth/liveCompanies', () => ({ isLiveCompanyForUser: m.isLive }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), notFound: vi.fn(), forbidden: vi.fn(), badRequest: vi.fn(), methodNotAllowed: vi.fn(), validationError: vi.fn() },
}));

import { apiResponse } from '@/lib/apiResponse';
import handler from '../../../pages/api/accounting/company-logo';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const CO = '11111111-1111-4111-8111-111111111111';
// 1x1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function call(companyId: unknown = CO) {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    status: vi.fn(() => res),
    send: vi.fn(),
  };
  const req = { method: 'GET', query: { companyId }, user: { id: 'user-1' } } as unknown as NextApiRequest;
  return { run: () => (handler as unknown as H)(req, res as unknown as NextApiResponse), res, headers };
}

beforeEach(() => vi.clearAllMocks());

describe('GET company-logo', () => {
  it('serves the stored PNG bytes with its type for a member', async () => {
    m.isLive.mockResolvedValue(true);
    m.sql.mockResolvedValue([{ logo_data: `data:image/png;base64,${PNG_B64}` }]);
    const c = call();
    await c.run();
    expect(m.isLive).toHaveBeenCalledWith('user-1', CO);
    expect(c.headers['Content-Type']).toBe('image/png');
    expect(c.headers['Cache-Control']).toMatch(/^private/);
    expect(c.res.status).toHaveBeenCalledWith(200);
    expect(Buffer.compare(c.res.send.mock.calls[0]![0] as Buffer, Buffer.from(PNG_B64, 'base64'))).toBe(0);
  });

  it('refuses a company the caller is not a live member of, without reading the logo', async () => {
    m.isLive.mockResolvedValue(false);
    await call().run();
    expect(apiResponse.forbidden).toHaveBeenCalled();
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID companyId', async () => {
    await call('nope').run();
    expect(apiResponse.badRequest).toHaveBeenCalled();
    expect(m.isLive).not.toHaveBeenCalled();
  });

  it('404s when there is no logo', async () => {
    m.isLive.mockResolvedValue(true);
    m.sql.mockResolvedValue([{ logo_data: null }]);
    const c = call();
    await c.run();
    expect(apiResponse.notFound).toHaveBeenCalled();
    expect(c.res.send).not.toHaveBeenCalled();
  });

  it('404s on a stored SVG or bytes that do not match the declared type', async () => {
    m.isLive.mockResolvedValue(true);
    for (const logo of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', `data:image/jpeg;base64,${PNG_B64}`]) {
      m.sql.mockResolvedValueOnce([{ logo_data: logo }]);
      const c = call();
      await c.run();
      expect(c.res.send).not.toHaveBeenCalled();
    }
    expect(apiResponse.notFound).toHaveBeenCalledTimes(2);
  });
});
