/**
 * Coding-metrics routes: who sees what, and where the company set comes from.
 *  - company route: req.companyId (withAuth) only; a companyId in the query is ignored.
 *  - bureau route: bureau members only; the companies are the bureau's bureau_companies; a viewer gets the
 *    per-client rows and no bureau total; owner and accountant get the total.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompanyCodingCounts, MonthPeriod } from '@/modules/accounting/services/bank/codingMetrics';

const { loadCodingCounts, getBureauRole, listBureauCompanies } = vi.hoisted(() => ({
  loadCodingCounts: vi.fn(),
  getBureauRole: vi.fn(),
  listBureauCompanies: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withUserAuth', () => ({ withUserAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/bank/codingMetricsService', () => ({ loadCodingCounts }));
vi.mock('@/modules/bureau/services/bureauSettingsService', () => ({ getBureauRole }));
vi.mock('@/modules/bureau/services/bureauService', () => ({ listBureauCompanies }));

import companyRoute from '../../../pages/api/accounting/coding-metrics';
import bureauRoute from '../../../pages/api/bureau/coding-metrics';

const CO = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-0000000000ff';
const BUREAU = '00000000-0000-4000-8000-0000000000b1';

const zero = (companyId: string): CompanyCodingCounts => ({
  companyId, linesCoded: 10, linesAutoCoded: 5, suggestionsDecided: 0, suggestionsAccepted: 0, autoPosted: 0,
  autoPostedReversed: 0, firstBatchAt: null, firstLineAt: null, firstWindowDecided: 0, firstWindowAccepted: 0,
  decisionLogSince: null,
});

function res() {
  const r = { statusCode: 200, body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
  return r;
}
async function call(route: unknown, req: Record<string, unknown>) {
  const out = res();
  await (route as (q: unknown, s: unknown) => Promise<unknown>)({ method: 'GET', headers: {}, ...req }, out);
  return out as { statusCode: number; body: { data?: Record<string, unknown> } };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadCodingCounts.mockImplementation(async (ids: string[], _p: MonthPeriod) => ids.map(zero));
});

describe('GET /api/accounting/coding-metrics', () => {
  it('reads the authenticated company only, whatever the query says', async () => {
    const r = await call(companyRoute, { companyId: CO, query: { companyId: OTHER, month: '2026-10' } });
    expect(r.statusCode).toBe(200);
    expect(loadCodingCounts).toHaveBeenCalledWith([CO], { month: '2026-10', from: '2026-10-01', to: '2026-11-01' });
    expect((r.body.data!.metrics as { autoCoded: { pct: number } }).autoCoded.pct).toBe(50);
  });
  it('a bad month is a 400 and reads nothing', async () => {
    const r = await call(companyRoute, { companyId: CO, query: { month: '2026-13' } });
    expect(r.statusCode).toBe(400);
    expect(loadCodingCounts).not.toHaveBeenCalled();
  });
});

describe('GET /api/bureau/coding-metrics', () => {
  beforeEach(() => {
    listBureauCompanies.mockResolvedValue([
      { bureauId: BUREAU, companyId: CO, companyName: 'Client A', addedAt: '2026-01-01' },
    ]);
  });

  it('a non-member: 403, nothing read', async () => {
    getBureauRole.mockResolvedValue(null);
    const r = await call(bureauRoute, { user: { id: 'u' }, query: { bureauId: BUREAU } });
    expect(r.statusCode).toBe(403);
    expect(listBureauCompanies).not.toHaveBeenCalled();
    expect(loadCodingCounts).not.toHaveBeenCalled();
  });

  it('the companies are the bureau\'s clients, never the query\'s', async () => {
    getBureauRole.mockResolvedValue('owner');
    await call(bureauRoute, { user: { id: 'u' }, query: { bureauId: BUREAU, companyId: OTHER } });
    expect(getBureauRole).toHaveBeenCalledWith('u', BUREAU);
    expect(loadCodingCounts.mock.calls[0]![0]).toEqual([CO]);
  });

  it('a viewer: per-client numbers, no bureau total', async () => {
    getBureauRole.mockResolvedValue('viewer');
    const r = await call(bureauRoute, { user: { id: 'u' }, query: { bureauId: BUREAU } });
    expect(r.statusCode).toBe(200);
    expect(r.body.data!.clients).toHaveLength(1);
    expect(r.body.data!.total).toBeNull();
  });

  it.each(['owner', 'accountant'] as const)('%s: the bureau total too', async (role) => {
    getBureauRole.mockResolvedValue(role);
    const r = await call(bureauRoute, { user: { id: 'u' }, query: { bureauId: BUREAU } });
    expect((r.body.data!.total as { autoCoded: { pct: number } }).autoCoded.pct).toBe(50);
  });

  it('no bureauId: 400', async () => {
    expect((await call(bureauRoute, { user: { id: 'u' }, query: {} })).statusCode).toBe(400);
  });
});
