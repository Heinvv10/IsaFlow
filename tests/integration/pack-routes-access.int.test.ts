// tests/integration/pack-routes-access.int.test.ts
//
// WHO REACHES THE PACK ROUTES, THROUGH THE REAL withAuth.
//
// `tests/unit/api/packRoutesRoleParity.test.ts` holds the screen route and the
// three download routes to one answer per company role, with withAuth stood
// in for. This is the half that needs the real thing: a request with no
// session, and a signed-in member of ANOTHER company asking for this one's
// pack, must not reach any of the four handlers — and every member of this
// company, whatever their role, must.
//
// Real withAuth, real session JWTs, real `company_users` rows. What the
// handlers go on to do (compose, render, export) is stood in for, so this
// measures access and nothing else.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { request, response } from './mfa-impersonation-postgres.helpers';

const reached = vi.hoisted(() => ({ calls: [] as string[] }));

// Both limiters let everything through: withAuth applies its own per-company
// limit on heavy routes, and the handlers apply the report one.
vi.mock('@/lib/rateLimit', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkRateLimit: vi.fn(async () => true),
  checkReportRateLimit: vi.fn(async () => true),
}));
vi.mock('@/lib/pdf/renderPagePdf', () => ({
  renderPagePdf: vi.fn(async (o: { companyId: string }) => { reached.calls.push(`pdf:${o.companyId}`); return Buffer.from('%PDF-1.7'); }),
}));
vi.mock('@/lib/pdf/printFurniture', () => ({
  buildFooterHtml: () => '<footer/>', buildPdfMetadata: () => ({ title: 't', subject: 's' }),
}));
vi.mock('@/modules/accounting/services/packs/pages/packFurniture', () => ({
  buildPackFurniture: vi.fn(async () => ({ companyName: 'Access Fixture' })),
}));
vi.mock('@/modules/accounting/services/packs/pages/boardPackDocument', () => ({
  buildBoardPackDocument: vi.fn(async (r: { companyId: string }) => { reached.calls.push(`pages:${r.companyId}`); return { pages: [] }; }),
}));
vi.mock('@/modules/accounting/services/packs/pages/packDocumentWire', () => ({
  serialisePackPagesDocument: (d: unknown) => d,
}));
const INPUT = {
  companyName: 'Access Fixture', period: '', revenue: 1000, costOfSales: 400, operatingExpenses: 200,
  netProfit: 400, totalAssets: 5000, totalLiabilities: 2000, totalEquity: 3000, currentAssets: 2500,
  currentLiabilities: 1000, cash: 800, accountsReceivable: 900, accountsPayable: 500, inventory: 100,
  otherIncome: 0, otherExpenses: 0, operatingProfit: 400, depreciation: 0,
  inventoryCaveat: null, classificationCaveat: null, cashFlowUnavailable: null,
};
vi.mock('@/modules/accounting/services/reports/reportPackDataService', () => ({
  getReportPackInput: vi.fn(async (companyId: string) => { reached.calls.push(`pptx:${companyId}`); return INPUT; }),
  readReportPackInput: vi.fn(async (companyId: string) => {
    reached.calls.push(`screen:${companyId}`);
    return { input: INPUT, figures: { period: {}, cumulative: { unclassifiedCount: 0 } } };
  }),
}));
vi.mock('@/modules/accounting/services/packs/packTrendService', () => ({ getPackTrend: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/packs/pptxExportService', () => ({
  renderPackPptx: vi.fn(async () => Buffer.from('PK')),
}));

import screenRoute from '../../pages/api/accounting/reports-pack';
import pdfRoute from '../../pages/api/accounting/packs/[id]/pdf';
import pagesRoute from '../../pages/api/accounting/packs/[id]/pages';
import pptxRoute from '../../pages/api/accounting/packs/[id]/pptx';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-0000005a0a01';
const OTHER_COMPANY = '00000000-0000-0000-0000-0000005a0b01';
const ROLES = ['owner', 'admin', 'manager', 'accountant', 'bookkeeper', 'viewer'] as const;
const userOf = (role: string) => `pr349-access-${role}`;
const OUTSIDER = 'pr349-access-outsider';

type Handler = (req: never, res: never) => Promise<unknown> | unknown;
const ROUTES: Array<[name: string, handler: Handler, url: string, query: Record<string, string>]> = [
  ['reports-pack (the screen)', screenRoute as Handler, '/api/accounting/reports-pack', { type: 'board', from: '2026-01-01', to: '2026-08-31' }],
  ['packs/[id]/pages', pagesRoute as Handler, '/api/accounting/packs/board/pages', { id: 'board', from: '2026-01-01', to: '2026-08-31' }],
  ['packs/[id]/pdf', pdfRoute as Handler, '/api/accounting/packs/board/pdf', { id: 'board', from: '2026-01-01', to: '2026-08-31' }],
  ['packs/[id]/pptx', pptxRoute as Handler, '/api/accounting/packs/board/pptx', { id: 'board', from: '2026-01-01', to: '2026-08-31' }],
];

async function session(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function call(
  handler: Handler, url: string, query: Record<string, string>,
  jar: Record<string, string>, method = 'GET',
): Promise<number> {
  const req = request(jar, method) as never as { query: Record<string, string>; url: string };
  req.query = query;
  req.url = url;
  const out = response();
  await handler(req as never, out.res as never);
  return out.state.statusCode;
}

const describeIfDb = isDisposableDb(DATABASE_URL) ? describe : describe.skip;

describeIfDb('who reaches the report-pack screen route and its three downloads', () => {
  let admin: Pool;
  const ORIGINAL_SECRET = process.env.PRINT_TOKEN_SECRET;

  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes companies, users and memberships.');
    process.env.PRINT_TOKEN_SECRET = 'a'.repeat(32);
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'Access Fixture', true), ($2, 'Access Fixture Other', true)`,
      [COMPANY, OTHER_COMPANY],
    );
    for (const role of ROLES) {
      // `users.role` has no 'owner'; the company role is what withAuth reads.
      await admin.query(
        `INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)`,
        [userOf(role), `${userOf(role)}@isaflow.test`, role === 'owner' ? 'admin' : role],
      );
      await admin.query(
        `INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)`,
        [COMPANY, userOf(role), role],
      );
    }
    await admin.query(
      `INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`,
      [OUTSIDER, `${OUTSIDER}@isaflow.test`],
    );
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [OTHER_COMPANY, OUTSIDER],
    );
  }, 60000);

  afterAll(async () => {
    if (ORIGINAL_SECRET === undefined) delete process.env.PRINT_TOKEN_SECRET;
    else process.env.PRINT_TOKEN_SECRET = ORIGINAL_SECRET;
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  beforeEach(() => { reached.calls.length = 0; });

  describe.each(ROLES)('a member of the company with the role %s', (role) => {
    it.each(ROUTES)('reaches %s', async (_name, handler, url, query) => {
      const jar = { 'sb-access-token': await session(userOf(role)), active_company_id: COMPANY };
      expect(await call(handler, url, query, jar)).toBe(200);
      // And it was this company the handler worked on.
      expect(reached.calls.length).toBeGreaterThan(0);
      expect(reached.calls.every((c) => c.endsWith(`:${COMPANY}`))).toBe(true);
    });
  });

  describe.each(ROUTES)('%s', (_name, handler, url, query) => {
    it('refuses a request with no session, before the handler', async () => {
      expect(await call(handler, url, query, { active_company_id: COMPANY })).toBe(401);
      expect(reached.calls).toEqual([]);
    });

    it('refuses a session that is not a real one', async () => {
      expect(await call(handler, url, query, { 'sb-access-token': 'not-a-token', active_company_id: COMPANY })).toBe(401);
      expect(reached.calls).toEqual([]);
    });

    it('refuses a signed-in member of ANOTHER company asking for this one', async () => {
      const jar = { 'sb-access-token': await session(OUTSIDER), active_company_id: COMPANY };
      expect(await call(handler, url, query, jar)).toBe(403);
      expect(reached.calls).toEqual([]);
    });

    it('serves that same person their own company, and only theirs', async () => {
      const jar = { 'sb-access-token': await session(OUTSIDER), active_company_id: OTHER_COMPANY };
      expect(await call(handler, url, query, jar)).toBe(200);
      expect(reached.calls.every((c) => c.endsWith(`:${OTHER_COMPANY}`))).toBe(true);
    });

    it('refuses a POST', async () => {
      const jar = { 'sb-access-token': await session(userOf('owner')), active_company_id: COMPANY };
      expect(await call(handler, url, query, jar, 'POST')).toBe(405);
      expect(reached.calls).toEqual([]);
    });
  });
});

async function cleanup(admin: Pool): Promise<void> {
  const users = [...ROLES.map(userOf), OUTSIDER];
  await admin.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
  await admin.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await admin.query('DELETE FROM companies WHERE id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
}
