/**
 * THE PACK DOWNLOADS ARE AVAILABLE TO EXACTLY THE ROLES THAT CAN SEE THE SCREEN.
 *
 * The report-packs screen is served by `reports-pack.ts`, which is wrapped in
 * `withWriteAccess`; the three routes behind its download buttons —
 * `packs/[id]/pdf`, `pages` and `pptx` — are not. That reads as a gap and is
 * not one: `withWriteAccess` gates POST, PUT, PATCH and DELETE only, and all
 * four routes are GET. Every member of the company loads the screen, and
 * every member can download from it.
 *
 * What would be a defect is the two sides coming apart — a role that sees the
 * buttons and gets 403 from them, or one that is refused the screen and can
 * still fetch the document. This holds them together: for every company role
 * the four routes answer alike, with the REAL `withWriteAccess` in the stack.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// withAuth is stood in for (it needs a session and a database); the role it
// would put on the request is put there by the test. withWriteAccess is real.
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await import('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ name: 'Acme Fibre (Pty) Ltd' }]) }));
vi.mock('@/lib/pdf/renderPagePdf', () => ({ renderPagePdf: vi.fn(async () => Buffer.from('%PDF-1.7')) }));
vi.mock('@/lib/pdf/printFurniture', () => ({
  buildFooterHtml: () => '<footer/>', buildPdfMetadata: () => ({ title: 't', subject: 's' }),
}));
vi.mock('@/modules/accounting/services/packs/pages/packFurniture', () => ({
  buildPackFurniture: vi.fn(async () => ({ companyName: 'Acme Fibre (Pty) Ltd' })),
}));
vi.mock('@/modules/accounting/services/packs/pages/boardPackDocument', () => ({
  buildBoardPackDocument: vi.fn(async () => ({ pages: [] })),
}));
vi.mock('@/modules/accounting/services/packs/pages/packDocumentWire', () => ({
  serialisePackPagesDocument: (d: unknown) => d,
}));
const INPUT = {
  companyName: 'Acme Fibre (Pty) Ltd', period: '', revenue: 1000, costOfSales: 400, operatingExpenses: 200,
  netProfit: 400, totalAssets: 5000, totalLiabilities: 2000, totalEquity: 3000, currentAssets: 2500,
  currentLiabilities: 1000, cash: 800, accountsReceivable: 900, accountsPayable: 500, inventory: 100,
  otherIncome: 0, otherExpenses: 0, operatingProfit: 400, depreciation: 0,
  inventoryCaveat: null, classificationCaveat: null, cashFlowUnavailable: null,
};
vi.mock('@/modules/accounting/services/reports/reportPackDataService', () => ({
  getReportPackInput: vi.fn(async () => INPUT),
  readReportPackInput: vi.fn(async () => ({ input: INPUT, figures: { period: {}, cumulative: { unclassifiedCount: 0 } } })),
}));
vi.mock('@/modules/accounting/services/reports/companyName', () => ({
  getCompanyName: vi.fn(async () => 'Acme Fibre (Pty) Ltd'),
}));
vi.mock('@/modules/accounting/services/packs/packTrendService', () => ({ getPackTrend: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/packs/pptxExportService', () => ({
  renderPackPptx: vi.fn(async () => Buffer.from('PK')),
}));

import screenRoute from '../../../pages/api/accounting/reports-pack';
import pdfRoute from '../../../pages/api/accounting/packs/[id]/pdf';
import pagesRoute from '../../../pages/api/accounting/packs/[id]/pages';
import pptxRoute from '../../../pages/api/accounting/packs/[id]/pptx';

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

/** The screen's own route, then the three behind its download buttons. */
const ROUTES: Array<[string, Route, Record<string, string>]> = [
  ['reports-pack (the screen)', screenRoute as Route, { type: 'board', from: '2026-01-01', to: '2026-08-31' }],
  ['packs/[id]/pages', pagesRoute as Route, { id: 'board', from: '2026-01-01', to: '2026-08-31' }],
  ['packs/[id]/pdf', pdfRoute as Route, { id: 'board', from: '2026-01-01', to: '2026-08-31' }],
  ['packs/[id]/pptx', pptxRoute as Route, { id: 'board', from: '2026-01-01', to: '2026-08-31' }],
];

/** Every role a company member can hold (admin user service) plus owner and manager. */
const ROLES = ['owner', 'admin', 'manager', 'accountant', 'bookkeeper', 'viewer'];

async function call(route: Route, query: Record<string, string>, role: string, method = 'GET'): Promise<number> {
  const res = {
    statusCode: 0,
    status(c: number) { this.statusCode = c; return this; },
    json() { return this; }, end() { return this; }, send() { return this; }, setHeader() { return this; },
  };
  await route({
    method, query, url: '/api/accounting/packs', headers: { cookie: 'sb-access-token=session' },
    companyId: 'c1', companyRole: role, user: { id: 'u1', email: 'someone@acme.test' },
  } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res.statusCode;
}

const ORIGINAL_SECRET = process.env.PRINT_TOKEN_SECRET;
beforeEach(() => { process.env.PRINT_TOKEN_SECRET = 'a'.repeat(32); });
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.PRINT_TOKEN_SECRET;
  else process.env.PRINT_TOKEN_SECRET = ORIGINAL_SECRET;
});

describe.each(ROLES)('a company %s', (role) => {
  it.each(ROUTES)('reaches %s', async (_name, route, query) => {
    expect(await call(route, query, role)).toBe(200);
  });

  it('gets the same answer from the screen as from each download behind it', async () => {
    const answers = await Promise.all(ROUTES.map(([, route, query]) => call(route, query, role)));
    expect(new Set(answers).size).toBe(1);
  });
});

describe('a method that is not GET', () => {
  it.each(ROUTES)('is refused by %s whatever the role', async (_name, route, query) => {
    expect(await call(route, query, 'owner', 'POST')).toBe(405);
  });
});
