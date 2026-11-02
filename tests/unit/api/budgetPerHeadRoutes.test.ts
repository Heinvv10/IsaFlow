/**
 * Per-head budget detail on the read routes (budgets decision 15, POPIA): GET budget-grid, GET
 * budget-drivers and GET budget-drivers/headcount, driven through the REAL services
 * (loadGridReadModel, listDrivers, readHeadcount, versionYear) with only the database, the fiscal
 * year registry and the grid's account loaders mocked. The fake `sql` answers a budget version
 * only for its own company, as the real company_id predicate does.
 *
 * The case is a cost centre with ONE employee: its per_head rate (R 32 017) is that person's pay.
 * A viewer gets the row's totals (the grid cells) and no rate, no headcount; an admin gets both;
 * another tenant's version and a request without a session are refused as before.
 *
 * Mutation check: pass 'full' from any route (or drop the role from it), answer counts to a viewer
 * in readHeadcount, or skip versionYear on the restricted path, and a test here goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FOREIGN_V = '22222222-2222-4222-8222-222222222222';
const V = '33333333-3333-4333-8333-333333333333';
const SAL = '44444444-4444-4444-8444-444444444444';
const RENT = '55555555-5555-4555-8555-555555555555';
const SOLO = '66666666-6666-4666-8666-666666666666';
const RATE = 32017;
const T = '2026-10-30T06:00:00.000001Z';

const m = vi.hoisted(() => ({ versionHeadcount: vi.fn(), listDriverLines: vi.fn(), sqlText: [] as string[] }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
// A request carrying a session (the test sets companyId + companyRole as withAuth would) goes to the handler;
// one without goes through the REAL withAuth, which refuses it before any database work.
vi.mock('@/lib/auth', async () => {
  const { withAuth } = await vi.importActual<typeof import('@/lib/auth/withAuth')>('@/lib/auth/withAuth');
  const { withWriteAccess } = await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess');
  type H = (req: NextApiRequest & { companyId?: string }, res: NextApiResponse) => unknown;
  return { withWriteAccess, withAuth: (h: H) => (req: NextApiRequest & { companyId?: string }, res: NextApiResponse) => (req.companyId ? h(req, res) : withAuth(h)(req, res)) };
});
vi.mock('@/lib/neon', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$');
    m.sqlText.push(text);
    const own = values.includes(COMPANY) && values.includes(V);
    if (/SELECT fiscal_year FROM budget_versions/.test(text)) return Promise.resolve(own ? [{ fiscal_year: 2027 }] : []);
    if (/SELECT id, fiscal_year FROM budget_versions/.test(text)) return Promise.resolve(own ? [{ id: V, fiscal_year: 2027 }] : []);
    if (/FROM cost_centres/.test(text)) return Promise.resolve(values.includes(SOLO) && values.includes(COMPANY) ? [{ one: 1 }] : []);
    if (/WITH v AS/.test(text)) {
      if (!own) return Promise.resolve([]);
      return Promise.resolve(['2026-03', '2026-04'].map((month) => ({
        token: T, status: 'draft', gl_account_id: SAL, cc1_id: SOLO, cc2_id: null, bu_id: null, month, amount: String(RATE), amount_source: 'driver',
      })));
    }
    return Promise.resolve([]);
  };
  return { sql, withSavepoint: (_n: string, fn: () => unknown) => fn() };
});
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', async (orig) => {
  const year = { id: 'fy', fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', status: 'open', kind: 'normal', stored: true };
  return { ...(await orig<Record<string, unknown>>()), getFiscalYear: vi.fn(async () => year), requireFiscalYear: vi.fn(async () => year) };
});
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({
  getVersion: vi.fn(async () => ({ id: V, fiscalYear: 2027, name: 'Budget', status: 'draft', updatedAt: T })),
}));
vi.mock('@/modules/accounting/services/budgets/gridReadAccounts', () => ({
  loadGridAccounts: vi.fn(async () => []), loadGridDimensions: vi.fn(async () => ({ cc1: [], cc2: [], bu: [] })), loadGridNotes: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/budgets/drivers/driverRepository', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), listDriverLines: m.listDriverLines,
}));
vi.mock('@/modules/accounting/services/budgets/drivers/driverHeadcount', () => ({ versionHeadcount: m.versionHeadcount }));

import gridRoute from '../../../pages/api/accounting/budget-grid/index';
import driversRoute from '../../../pages/api/accounting/budget-drivers/index';
import headcountRoute from '../../../pages/api/accounting/budget-drivers/headcount';

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
type Sent = { data?: Record<string, unknown>; error?: { code?: string; details?: Record<string, unknown> } };

async function call(route: unknown, query: Record<string, string>, session: { role: string } | null) {
  const req = {
    method: 'GET', query, body: undefined, cookies: {}, headers: {}, url: '/api/accounting/x',
    ...(session ? { companyId: COMPANY, companyRole: session.role, user: { id: 'user-1', claims: {} } } : {}),
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  await (route as Route)(req, res as unknown as NextApiResponse);
  return res as typeof res & { sent: Sent };
}

const line = {
  cc2Id: null, buId: null, fromMonth: '2026-03', toMonth: '2027-02', pct: null, ref: null, section: null, scope: null, baseMonth: null, rounding: 1, updatedAt: T,
};
const perHead = { ...line, id: 'd-head', glAccountId: SAL, cc1Id: SOLO, kind: 'per_head', amount: RATE, headcountCostCentreId: SOLO };
const fixed = { ...line, id: 'd-rent', glAccountId: RENT, cc1Id: null, kind: 'fixed', amount: 1500, headcountCostCentreId: null };
const VIEWER = { role: 'viewer' };
const ADMIN = { role: 'admin' };

const driversOf = (sent: Sent) => sent.data!.drivers as Array<Record<string, unknown>>;

beforeEach(() => {
  m.sqlText.length = 0;
  m.listDriverLines.mockReset().mockResolvedValue([perHead, fixed]);
  m.versionHeadcount.mockReset().mockResolvedValue(() => new Map([['2026-03', { payroll: 1, hires: 0, total: 1 }]]));
});

describe('GET budget-grid: one-person cost centre', () => {
  it('a reader gets the row totals and the drivers, the per_head line without its rate', async () => {
    const r = await call(gridRoute, { version_id: V }, VIEWER);
    expect(r.statusCode).toBe(200);
    const cells = r.sent.data!.cells as Array<{ cc1Id: string; amount: number }>;
    expect(cells.filter((c) => c.cc1Id === SOLO).map((c) => c.amount)).toEqual([RATE, RATE]);
    const [head, rent] = driversOf(r.sent);
    expect(head).not.toHaveProperty('amount');
    expect(head).toMatchObject({ kind: 'per_head', perHeadRestricted: true, headcountCostCentreId: SOLO });
    expect(rent).toMatchObject({ kind: 'fixed', amount: 1500 });
    expect(JSON.stringify(r.sent.data!.drivers)).not.toContain(String(RATE));
  });

  it('a writer gets the per_head rate', async () => {
    const r = await call(gridRoute, { version_id: V }, ADMIN);
    expect(r.statusCode).toBe(200);
    expect(driversOf(r.sent)[0]).toMatchObject({ kind: 'per_head', amount: RATE });
    expect(driversOf(r.sent)[0]).not.toHaveProperty('perHeadRestricted');
  });

  it("another tenant's version is 404 for either role", async () => {
    for (const s of [VIEWER, ADMIN]) expect((await call(gridRoute, { version_id: FOREIGN_V }, s)).statusCode).toBe(404);
  });
});

describe('GET budget-drivers', () => {
  it('a reader gets the per_head line without an amount key; a writer gets the rate', async () => {
    const reader = await call(driversRoute, { versionId: V }, VIEWER);
    expect(reader.statusCode).toBe(200);
    expect(driversOf(reader.sent)[0]).not.toHaveProperty('amount');
    expect(driversOf(reader.sent)[0]).toMatchObject({ perHeadRestricted: true });
    expect(driversOf(reader.sent)[1]).toMatchObject({ amount: 1500 });
    for (const role of ['owner', 'admin', 'manager']) {
      const writer = await call(driversRoute, { versionId: V }, { role });
      expect(driversOf(writer.sent)[0]).toMatchObject({ kind: 'per_head', amount: RATE });
    }
  });

  it("another tenant's version is 404, before any driver is read", async () => {
    const r = await call(driversRoute, { versionId: FOREIGN_V }, VIEWER);
    expect(r.statusCode).toBe(404);
    expect(m.listDriverLines).not.toHaveBeenCalled();
  });
});

describe('GET budget-drivers/headcount', () => {
  it('a reader of the one-person centre gets no counts, and payroll is not read', async () => {
    const r = await call(headcountRoute, { versionId: V, costCentreId: SOLO }, VIEWER);
    expect(r.statusCode).toBe(200);
    expect(r.sent.data).toEqual({ costCentreId: SOLO, perHeadRestricted: true });
    expect(r.sent.data).not.toHaveProperty('months');
    expect(r.sent.data).not.toHaveProperty('asOf');
    expect(m.versionHeadcount).not.toHaveBeenCalled();
    const company = await call(headcountRoute, { versionId: V }, VIEWER);
    expect(company.sent.data).toEqual({ costCentreId: null, perHeadRestricted: true });
  });

  it('a writer gets the counts', async () => {
    const r = await call(headcountRoute, { versionId: V, costCentreId: SOLO }, ADMIN);
    expect(r.statusCode).toBe(200);
    expect((r.sent.data!.months as Array<{ month: string; total: number }>).find((x) => x.month === '2026-03')).toMatchObject({ payroll: 1, total: 1 });
    expect(r.sent.data).not.toHaveProperty('perHeadRestricted');
  });

  it("a reader is still refused another tenant's version (404) and cost centre (400)", async () => {
    expect((await call(headcountRoute, { versionId: FOREIGN_V }, VIEWER)).statusCode).toBe(404);
    expect((await call(headcountRoute, { versionId: V, costCentreId: '77777777-7777-4777-8777-777777777777' }, VIEWER)).statusCode).toBe(400);
  });
});

describe('without a session', () => {
  it('every route is 401 and reads nothing', async () => {
    for (const [route, query] of [[gridRoute, { version_id: V }], [driversRoute, { versionId: V }], [headcountRoute, { versionId: V }]] as const) {
      const r = await call(route, query, null);
      expect(r.statusCode).toBe(401);
    }
    expect(m.sqlText).toEqual([]);
    expect(m.listDriverLines).not.toHaveBeenCalled();
  });
});
