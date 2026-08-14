/**
 * Pentest MEDIUM (resource-exhaustion DoS): heavy report/export/PDF endpoints
 * were gated only by withAuth/withWriteAccess, with no request-frequency
 * throttle. A scripted authenticated client could hammer them in a loop,
 * driving sustained CPU/memory (PDF rendering, large SQL aggregations) — a
 * same-tenant DoS. These endpoints now call checkReportRateLimit(companyId, ...)
 * before doing any work. These tests assert each returns 429 (and never
 * reaches the underlying report/export logic) when the limiter says over.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
  withWriteAccess: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([{}]) }));
vi.mock('@/lib/csv', () => ({ escapeCsv: vi.fn((v: unknown) => String(v)), csvCell: vi.fn((v: unknown) => String(v)) }));

const { checkReportRateLimitMock } = vi.hoisted(() => ({ checkReportRateLimitMock: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkReportRateLimit: checkReportRateLimitMock,
  checkRateLimit: vi.fn().mockResolvedValue(true),
  checkAiRateLimit: vi.fn().mockResolvedValue(true),
  checkSendRateLimit: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}));

// Auto-mock the downstream report/export service modules so imports resolve;
// they are never reached because the rate-limit gate returns early.
vi.mock('@/modules/accounting/services/reports/reportPackService', () => ({
  buildReportPack: vi.fn().mockReturnValue({ companyName: 'Co', period: '', sections: [] }),
}));
vi.mock('@/modules/accounting/services/core/pdfShared', () => ({
  fmtZAR: vi.fn(), TEAL: { r: 0, g: 0, b: 0 }, renderPageFooters: vi.fn(),
  hexToRgb: vi.fn(() => ({ r: 0, g: 0, b: 0 })),
  getCompanyDetailsFromCompany: vi.fn().mockResolvedValue({ name: 'Co', primaryColor: '#000000' }),
}));
vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({
  getIncomeStatement: vi.fn().mockResolvedValue({
    totalRevenue: 0, totalCostOfSales: 0, totalOperatingExpenses: 0, netProfit: 0,
  }),
  getBalanceSheet: vi.fn().mockResolvedValue({
    totalAssets: 0, totalLiabilities: 0, totalEquity: 0, assets: [], liabilities: [],
  }),
}));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  getAuditLog: vi.fn(), logAuditOrThrow: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/transactionReportingService', () => ({
  getAccountTransactions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/casewareExportService', () => ({
  exportCaseWareTB: vi.fn(),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(),
    methodNotAllowed: vi.fn(), notFound: vi.fn(), forbidden: vi.fn(), internalError: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import reportsPdf from '../../../pages/api/accounting/reports-pdf';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import reportsHtml from '../../../pages/api/accounting/reports-html';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import reportsPack from '../../../pages/api/accounting/reports-pack';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import auditLogExport from '../../../pages/api/accounting/audit-log-export';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import accountTransactionsExport from '../../../pages/api/accounting/account-transactions-export';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import casewareExport from '../../../pages/api/accounting/caseware-export';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), send: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

const COMPANY_ID = '11111111-1111-4111-9111-111111111111';

function req(method: string, extra: Record<string, unknown> = {}): NextApiRequest {
  return {
    method,
    query: {},
    body: { type: 'monthly', from: '2026-01-01', to: '2026-01-31' },
    companyId: COMPANY_ID,
    user: { id: 'u1', email: 'u1@example.com' },
    headers: {},
    socket: {},
    ...extra,
  } as unknown as NextApiRequest;
}

const CASES: Array<[string, Handler, string, Record<string, unknown>]> = [
  ['reports-pdf', reportsPdf as Handler, 'POST', {}],
  ['reports-html', reportsHtml as Handler, 'POST', {}],
  ['reports-pack', reportsPack as Handler, 'GET', { query: { type: 'monthly' } }],
  ['audit-log-export', auditLogExport as Handler, 'GET', {}],
  [
    'account-transactions-export',
    accountTransactionsExport as Handler,
    'GET',
    { query: { account_code: '1000', period_start: '2026-01-01', period_end: '2026-01-31' } },
  ],
  ['caseware-export', casewareExport as Handler, 'GET', { query: { period_start: '2026-01-01', period_end: '2026-01-31' } }],
];

describe('Report/export endpoints — per-company throttle via checkReportRateLimit', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(CASES)('%s returns 429 (via checkReportRateLimit) when over the limit', async (_name, handler, method, extra) => {
    checkReportRateLimitMock.mockResolvedValue(false);
    await handler(req(method, extra), makeRes());
    expect(checkReportRateLimitMock).toHaveBeenCalledTimes(1);
    expect(checkReportRateLimitMock).toHaveBeenCalledWith(COMPANY_ID, expect.any(String));
    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
  });

  it.each(CASES)('%s proceeds past the gate when under the limit', async (_name, handler, method, extra) => {
    checkReportRateLimitMock.mockResolvedValue(true);
    await handler(req(method, extra), makeRes());
    expect(checkReportRateLimitMock).toHaveBeenCalledTimes(1);
    expect(apiResponse.tooManyRequests).not.toHaveBeenCalled();
  });
});
