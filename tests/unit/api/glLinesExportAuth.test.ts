/**
 * /api/accounting/gl-lines-export behind withBearerOrCookieAuth + withScope:
 * an external system (FibreFlow) pulls the export with a read-only Personal
 * Access Token instead of a browser session.
 *
 * The route, both wrappers and the shared Bearer pipeline are the REAL code;
 * only the edges are replaced: the pg pool (the pipeline's transaction), the
 * PAT lookup, the cookie withAuth, the rate limiters and the export services.
 *
 *  - a PAT with read:reports is served, under the TOKEN's company, inside the
 *    pipeline's app_user transaction with the RLS claims set
 *  - a PAT without read:reports is 403 before any export read
 *  - counterparties needs read:contacts, bank_accounts read:bank-tx (the MCP tool's rule)
 *  - a computed table is as at today and refuses date_from / date_to / status
 *  - a cookie session is unchanged: withAuth, no scopes, every table
 *  - a computed table carries its control facts as headers
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';

const h = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const client = { query: clientQuery, release: vi.fn() };
  return {
    client, clientQuery, connect: vi.fn(async () => client),
    tablePage: vi.fn(), buildComputed: vi.fn(), logError: vi.fn(),
    cookieCompany: '99999999-9999-4999-8999-999999999999',
  };
});

vi.mock('pg', () => ({ default: { ...pgTypesMock(), Pool: class { connect = h.connect; on = vi.fn(); } } }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() }), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: (...a: unknown[]) => h.logError(...a), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: (...a: unknown[]) => h.logError(...a), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/als', () => ({ als: { run: vi.fn((_s: unknown, cb: () => unknown) => cb()) } }));
vi.mock('@sentry/nextjs', () => ({ withIsolationScope: vi.fn(async (cb: () => unknown) => cb()), setTag: vi.fn() }));
vi.mock('@/lib/sentry/tags', () => ({ setTenantTags: vi.fn(), sanitizeRoute: vi.fn((r: string) => r) }));
vi.mock('@/lib/auth/personalAccessTokens', () => ({ validatePat: vi.fn() }));
vi.mock('@/lib/auth/oauth', () => ({ validateOauthAccessToken: vi.fn() }));
vi.mock('@/lib/auth/autoRateLimit', () => ({ checkAutoRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => true),
  checkReportRateLimit: vi.fn(async () => true),
  getClientIp: vi.fn(() => '10.0.0.1'),
}));
// The cookie path: withAuth attaches the session's company and NO scopes.
vi.mock('@/lib/auth/withAuth', () => ({
  withAuth: vi.fn((handler: (q: unknown, s: unknown) => unknown) => async (req: Record<string, unknown>, res: unknown) => {
    req.companyId = h.cookieCompany;
    return handler(req, res);
  }),
}));
vi.mock('@/modules/accounting/services/reports/glLineExportTables', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getExportDimensionTablePage: h.tablePage,
}));
vi.mock('@/modules/accounting/services/reports/glExportComputedTables', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildComputedTable: h.buildComputed,
}));

import { validatePat } from '@/lib/auth/personalAccessTokens';
import { withAuth } from '@/lib/auth/withAuth';
import handler from '../../../pages/api/accounting/gl-lines-export';

process.env.DATABASE_URL ||= 'postgres://unit-test-not-used';
const TOKEN_COMPANY = '22222222-2222-4222-8222-222222222222';
const RAW = `pat_${'A'.repeat(32)}`;

interface FakeRes {
  statusCode: number; headers: Record<string, unknown>; body: unknown; chunks: string[]; headersSent: boolean;
  setHeader(k: string, v: unknown): FakeRes; getHeader(k: string): unknown; removeHeader(k: string): void; status(c: number): FakeRes;
  json(b: unknown): FakeRes; write(c: string): boolean; end(...a: unknown[]): FakeRes;
  once(): FakeRes; off(): FakeRes; on(): FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200, headers: {}, body: undefined, chunks: [], headersSent: false,
    setHeader(k, v) { res.headers[k] = v; return res; },
    getHeader(k) { return res.headers[k]; },
    removeHeader(k) { delete res.headers[k]; },
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res.end(); },
    write(c) { res.headersSent = true; res.chunks.push(c); return true; },
    end(...a) { if (typeof a[0] === 'string') res.chunks.push(a[0]); return res; },
    once() { return res; }, off() { return res; }, on() { return res; },
  };
  return res;
}

async function call(query: Record<string, string>, auth?: string): Promise<FakeRes> {
  const res = makeRes();
  const req = { method: 'GET', url: '/api/accounting/gl-lines-export', query, headers: auth ? { authorization: auth } : {} };
  await (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  return res;
}

function pat(scopes: string[]): void {
  vi.mocked(validatePat).mockResolvedValue({ patId: 'p1', userId: 'u1', companyId: TOKEN_COMPANY, scopes });
}

const csv = (res: FakeRes) => res.chunks.join('');
const errorCode = (res: FakeRes) => (res.body as { error?: { code?: string } } | undefined)?.error?.code;

beforeEach(() => {
  vi.clearAllMocks();
  h.clientQuery.mockImplementation(async (text: unknown) => (
    typeof text === 'string' && text.includes('company_users')
      ? { rows: [{ role: 'member', account_user_id: 'u1', is_active: true, status: 'active', suspended_at: null }] }
      : { rows: [] }));
  h.tablePage.mockResolvedValue({
    columns: ['Counterparty_ID', 'Counterparty_Name'], rows: [{ Counterparty_ID: 'c1', Counterparty_Name: 'Blitz' }], next: null,
  });
  h.buildComputed.mockResolvedValue({
    columns: ['Doc_ID', 'Outstanding'],
    rows: [{ Doc_ID: 'd1', Outstanding: 100.5 }, { Doc_ID: 'd2', Outstanding: -0.5 }],
    summary: {
      table: 'ap_open_items', schemaVersion: 'isaflow-open-items-1.0', asAt: '2026-10-22', rowCount: 2,
      controlTotal: 100, agedTotal: 100, difference: 0, disputedTotal: 12.5,
    },
  });
});

// No answer here is a caught failure: every 403 / 200 is the route's own.
afterEach(() => { expect(h.logError).not.toHaveBeenCalled(); });

describe('gl-lines-export with a Personal Access Token', () => {
  it('read:reports → 200 CSV for the token\'s company, inside the pipeline transaction', async () => {
    pat(['read:reports']);
    const res = await call({ table: 'accounts' }, `Bearer ${RAW}`);
    expect(res.statusCode).toBe(200);
    expect(csv(res).split('\n')[0]).toBe('Counterparty_ID,Counterparty_Name');
    expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-Schema-Version']).toBe('isaflow-gl-lines-1.0');
    expect(h.tablePage).toHaveBeenCalledWith(TOKEN_COMPANY, 'accounts', null, expect.any(Number));
    const statements = h.clientQuery.mock.calls.map((c) => String(c[0]));
    expect(statements).toContain('SET LOCAL ROLE app_user');
    expect(statements.some((s) => s.includes('app.current_company_id'))).toBe(true);
    expect(statements).toContain('COMMIT');
    expect(withAuth).not.toHaveBeenCalled();
  });

  it('a token without read:reports → 403 INSUFFICIENT_SCOPE, nothing read', async () => {
    pat(['read:invoices', 'read:contacts']);
    const res = await call({ table: 'accounts' }, `Bearer ${RAW}`);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('INSUFFICIENT_SCOPE');
    expect(h.tablePage).not.toHaveBeenCalled();
    expect(h.buildComputed).not.toHaveBeenCalled();
  });

  it('counterparties with read:reports alone → 403 naming read:contacts, nothing read', async () => {
    pat(['read:reports']);
    const res = await call({ table: 'counterparties' }, `Bearer ${RAW}`);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('INSUFFICIENT_SCOPE');
    expect(JSON.stringify(res.body)).toContain('read:contacts');
    expect(h.tablePage).not.toHaveBeenCalled();
  });

  it('counterparties with read:reports + read:contacts → 200', async () => {
    pat(['read:reports', 'read:contacts']);
    const res = await call({ table: 'counterparties' }, `Bearer ${RAW}`);
    expect(res.statusCode).toBe(200);
    expect(h.tablePage).toHaveBeenCalledWith(TOKEN_COMPANY, 'counterparties', null, expect.any(Number));
  });

  it('ap_open_items carries its control facts as headers and streams every row', async () => {
    pat(['read:reports']);
    const res = await call({ table: 'ap_open_items' }, `Bearer ${RAW}`);
    expect(res.statusCode).toBe(200);
    expect(h.buildComputed).toHaveBeenCalledWith(TOKEN_COMPANY, 'ap_open_items');
    expect(res.headers).toMatchObject({
      'X-Schema-Version': 'isaflow-open-items-1.0', 'X-As-At': '2026-10-22', 'X-Row-Count': '2',
      'X-Control-Total': '100.00', 'X-Aged-Total': '100.00', 'X-Control-Difference': '0.00', 'X-Disputed-Total': '12.50',
    });
    expect(res.headers).not.toHaveProperty('X-No-Ledger-Balance-Count');
    expect(csv(res)).toBe('Doc_ID,Outstanding\n"d1",100.50\n"d2",-0.50\n');
  });

  it('bank_accounts with read:reports alone → 403 naming read:bank-tx, nothing built', async () => {
    pat(['read:reports']);
    const res = await call({ table: 'bank_accounts' }, `Bearer ${RAW}`);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('INSUFFICIENT_SCOPE');
    expect(JSON.stringify(res.body)).toContain('read:bank-tx');
    expect(h.buildComputed).not.toHaveBeenCalled();
  });

  it('bank_accounts with read:reports + read:bank-tx → 200, with the count X-Control-Total leaves out', async () => {
    pat(['read:reports', 'read:bank-tx']);
    h.buildComputed.mockResolvedValueOnce({
      columns: ['Bank_Account_ID'], rows: [{ Bank_Account_ID: 'b1' }],
      summary: {
        table: 'bank_accounts', schemaVersion: 'isaflow-bank-accounts-1.0', asAt: '2026-10-22', rowCount: 1,
        controlTotal: 0, noLedgerBalanceCount: 1, unreconciledLineCount: 0, unallocatedLineCount: 0,
      },
    });
    const res = await call({ table: 'bank_accounts' }, `Bearer ${RAW}`);
    expect(res.statusCode).toBe(200);
    expect(h.buildComputed).toHaveBeenCalledWith(TOKEN_COMPANY, 'bank_accounts');
    expect(res.headers).toMatchObject({ 'X-No-Ledger-Balance-Count': '1', 'X-Control-Total': '0.00' });
    expect(res.headers).not.toHaveProperty('X-Aged-Total');
  });

  it('a computed table refuses date_from, date_to and status (400) — it is as at today', async () => {
    pat(['read:reports']);
    for (const extra of [{ date_from: '2026-01-01' }, { date_to: '2026-09-30' }, { status: 'posted' }]) {
      const res = await call({ table: 'ap_open_items', ...extra }, `Bearer ${RAW}`);
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.body)).toContain('as at today');
    }
    expect(h.buildComputed).not.toHaveBeenCalled();
  });

  it('manifest=1 on a computed table answers the summary as JSON, no rows', async () => {
    pat(['read:reports']);
    const res = await call({ table: 'ap_open_items', manifest: '1' }, `Bearer ${RAW}`);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ controlTotal: 100, agedTotal: 100, difference: 0, rowCount: 2 });
    expect(res.headers['X-Schema-Version']).toBe('isaflow-open-items-1.0');
    expect(res.chunks.join('')).not.toContain('Doc_ID,');
  });
});

describe('gl-lines-export with a browser session (unchanged)', () => {
  it('no Authorization header → cookie withAuth, no scope gate, every table served', async () => {
    const res = await call({ table: 'counterparties' });
    expect(withAuth).toHaveBeenCalled();
    expect(validatePat).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(h.tablePage).toHaveBeenCalledWith(h.cookieCompany, 'counterparties', null, expect.any(Number));
    expect(h.connect).not.toHaveBeenCalled(); // never the Bearer pipeline's pool
  });
});
