/** Wave 6 LC: GET /api/accounting/sars/vat201-late-claims wiring (the figures are in the integration suite). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), limit: vi.fn(),
  Mismatch: class Vat201LateClaimsMismatchError extends Error {},
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: mocks.limit, INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 } }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/vat201LateClaims', () => ({ getVat201LateClaims: mocks.get, Vat201LateClaimsMismatchError: mocks.Mismatch }));

import handler from '../../../pages/api/accounting/sars/vat201-late-claims';

function call(query: Record<string, string>, method = 'GET') {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    end() { return res; },
  } as unknown as NextApiResponse;
  const req = { method, query, headers: {}, companyId: 'co-a', companyRole: 'viewer', user: { id: 'u1' } } as unknown as NextApiRequest;
  return (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res).then(() => out);
}

describe('GET /api/accounting/sars/vat201-late-claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue(true);
    mocks.get.mockResolvedValue({ rows: [], total: 0, lateClaimInputTax: 0 });
  });

  it('reads the caller\'s company and period, no-store', async () => {
    const r = await call({ from: '2026-11-01', to: '2026-12-31' });
    expect(r.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith('co-a', '2026-11-01', '2026-12-31');
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(mocks.limit.mock.calls[0]![1]).toBe('vat201-late-claims:u:u1');
  });

  it('refuses a missing, malformed or over-long window before reading', async () => {
    for (const q of [{}, { from: '2026-11-01' }, { from: 'x', to: '2026-12-31' }, { from: '2025-01-01', to: '2026-12-31' }]) {
      expect((await call(q as Record<string, string>)).status).toBe(400);
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('405 on a write; 429 past the rate limit, before reading', async () => {
    expect((await call({ from: '2026-11-01', to: '2026-12-31' }, 'POST')).status).toBe(405);
    mocks.limit.mockResolvedValue(false);
    expect((await call({ from: '2026-11-01', to: '2026-12-31' })).status).toBe(429);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('the window boundary: 400 days is read, 401 is refused, from after to is refused', async () => {
    expect((await call({ from: '2025-01-01', to: '2026-02-05' })).status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith('co-a', '2025-01-01', '2026-02-05');
    mocks.get.mockClear();
    const over = await call({ from: '2025-01-01', to: '2026-02-06' });
    expect(over.status).toBe(400);
    expect(JSON.stringify(over.body)).toContain('400 days');
    expect((await call({ from: '2026-12-31', to: '2026-11-01' })).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('a mismatch is a 500 carrying its own message (period and totals), not the masked generic one', async () => {
    const msg = 'VAT201 2026-11-01 to 2026-12-31: the late claims listed total R1.00, but the input-tax boxes carry R2.00 of late claims.';
    mocks.get.mockRejectedValue(new mocks.Mismatch(msg));
    const r = await call({ from: '2026-11-01', to: '2026-12-31' });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).toContain(msg);
  });

  it('any other fault propagates to the error handler, never a 200', async () => {
    mocks.get.mockRejectedValue(new Error('boom'));
    await expect(call({ from: '2026-11-01', to: '2026-12-31' })).rejects.toThrow('boom');
  });
});
