import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({
  assertNot: vi.fn(),
  vat: vi.fn(), emp: vi.fn(), actor: vi.fn(), limit: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', async () => {
  const real = await vi.importActual<typeof import('@/lib/auth/impersonationGuard')>('@/lib/auth/impersonationGuard');
  return { ...real, assertNotImpersonating: mocks.assertNot };
});
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: mocks.actor }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: mocks.limit, INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 } }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/vat201FieldDrill', () => ({ vat201FieldDrill: mocks.vat, MAX_DRILL_PAGE_SIZE: 200 }));
vi.mock('@/modules/accounting/services/reports/emp201FieldDrill', () => ({
  emp201FieldDrill: mocks.emp, isEmp201DrillField: (f: string) => ['paye', 'eti', 'uif', 'sdl', 'remuneration'].includes(f),
}));

import handler from '../../../pages/api/accounting/sars/return-drill';

const RUN = '22222222-2222-4222-8222-222222222222';
function call(role: string, query: Record<string, string>) {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    end() { return res; },
  } as unknown as NextApiResponse;
  const req = { method: 'GET', query, headers: {}, companyId: 'co-a', companyRole: role, user: { id: 'u1' } } as unknown as NextApiRequest;
  return (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res).then(() => out);
}
const Q = { from: '2026-05-01', to: '2026-05-31' };

describe('GET /api/accounting/sars/return-drill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.mockResolvedValue('self');
    mocks.assertNot.mockResolvedValue(undefined);
    mocks.limit.mockResolvedValue(true);
    mocks.vat.mockResolvedValue({ source: 'none' });
    mocks.emp.mockResolvedValue({ rows: [] });
  });

  it('a viewer gets VAT but not EMP201', async () => {
    expect((await call('viewer', { ...Q, return: 'vat201', field: '4' })).status).toBe(200);
    const emp = await call('viewer', { ...Q, return: 'emp201', field: 'paye' });
    expect(emp.status).toBe(403);
    expect(mocks.emp).not.toHaveBeenCalled();
  });

  it('every answer, refusals included, is no-store', async () => {
    for (const [role, q] of [['viewer', { return: 'emp201', field: 'paye' }], ['owner', { return: 'emp201', field: 'paye' }],
      ['owner', { return: 'nope', field: 'x' }]] as const) {
      expect((await call(role, { ...Q, ...q })).headers['Cache-Control']).toBe('no-store');
    }
  });

  it('refuses a token channel for EMP201, before reading anything', async () => {
    mocks.actor.mockResolvedValue('unknown');
    const r = await call('owner', { ...Q, return: 'emp201', field: 'paye' });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain('AGENT_FORBIDDEN');
    expect(mocks.emp).not.toHaveBeenCalled();
  });

  it('refuses Login-as for EMP201 (403 IMPERSONATION_FORBIDDEN) but not for VAT', async () => {
    const { ImpersonationForbiddenError } = await import('@/lib/auth/impersonationGuard');
    mocks.assertNot.mockRejectedValue(new ImpersonationForbiddenError());
    const emp = await call('owner', { ...Q, return: 'emp201', field: 'paye' });
    expect(emp.status).toBe(403);
    expect(JSON.stringify(emp.body)).toContain('IMPERSONATION_FORBIDDEN');
    expect(mocks.emp).not.toHaveBeenCalled();
    expect((await call('owner', { ...Q, return: 'vat201', field: '4' })).status).toBe(200);
  });

  it('another company\'s (or any unknown) run is 404, scoped to the caller\'s company', async () => {
    mocks.emp.mockResolvedValue(null);
    const r = await call('owner', { ...Q, return: 'emp201', field: 'paye', runId: RUN });
    expect(r.status).toBe(404);
    expect(mocks.emp).toHaveBeenCalledWith('co-a', '2026-05-01', '2026-05-31', 'paye', expect.objectContaining({ runId: RUN }));
  });

  it('an unknown VAT field is 404; bad input is 400; the page size cap is 200', async () => {
    mocks.vat.mockResolvedValue(null);
    expect((await call('owner', { ...Q, return: 'vat201', field: '99' })).status).toBe(404);
    expect((await call('owner', { ...Q, return: 'vat201', field: '4', pageSize: '201' })).status).toBe(400);
    expect((await call('owner', { ...Q, return: 'vat201', field: '4', page: '0' })).status).toBe(400);
    expect((await call('owner', { ...Q, return: 'emp201', field: 'paye', runId: 'x' })).status).toBe(400);
    expect((await call('owner', { from: 'bad', to: '2026-05-31', return: 'vat201', field: '4' })).status).toBe(400);
  });

  it('is rate-limited', async () => {
    mocks.limit.mockResolvedValue(false);
    expect((await call('owner', { ...Q, return: 'vat201', field: '4' })).status).toBe(429);
    expect(mocks.vat).not.toHaveBeenCalled();
  });
});
