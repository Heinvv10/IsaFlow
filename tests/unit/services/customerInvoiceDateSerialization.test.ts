/**
 * Regression tests for customer-invoice DATE serialization.
 *
 * Bug family: pg returns DATE columns as JS Date objects; on a UTC+2 server,
 * serializing those through toISOString()/JSON rolls the date back a day.
 * Fix (branch fix/customer-invoice-date-persistence): the list and detail
 * queries serialize DATE columns in SQL via to_char(col, 'YYYY-MM-DD') so the
 * wire format is a plain date string regardless of server timezone.
 *
 * These tests capture the SQL template TEXT (not just interpolated params —
 * the older customerInvoicesList tests only inspect params, which is why this
 * regression slipped past them) and assert the to_char serialization is
 * present for every DATE column the frontend consumes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ── Mocks must be hoisted before any imports that use them ────────────────────

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Capture the raw template text of every sql`` call.
const sqlTexts: string[] = [];

vi.mock('@/lib/neon', () => {
  const mockSql = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    sqlTexts.push(strings.join('?'));
    return Promise.resolve([]);
  });
  return {
    sql: mockSql,
    withTransaction: vi.fn(),
    fmtDate: vi.fn((d: unknown) => String(d)),
  };
});

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: Function) => fn,
  withWriteAccess: (fn: Function) => fn,
}));

vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (fn: Function) => fn,
}));

vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (fn: Function) => fn,
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => data),
    badRequest: vi.fn(),
    notFound: vi.fn(),
    validationError: vi.fn(),
    methodNotAllowed: vi.fn(),
    databaseError: vi.fn(),
    internalError: vi.fn(),
  },
}));

vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  postCustomerInvoiceToGL: vi.fn(),
}));

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(),
}));

// ── Import handlers after mocks ───────────────────────────────────────────────

import listHandler from '../../../pages/api/accounting/customer-invoices-list';
import detailHandler from '../../../pages/api/accounting/customer-invoices-detail';

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY_ID = 'cccccccc-0000-0000-0000-cccccccccccc';
const INVOICE_ID = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

function makeReq(query: Record<string, string> = {}): NextApiRequest {
  return {
    method: 'GET',
    query,
    companyId: COMPANY_ID,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse {
  return {} as NextApiResponse;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('customer-invoice DATE serialization (UTC+2 rollback regression)', () => {
  beforeEach(() => {
    sqlTexts.length = 0;
    vi.clearAllMocks();
  });

  it('list query serializes invoice_date and due_date via to_char in SQL', async () => {
    await (listHandler as Function)(makeReq({ limit: '25' }), makeRes());

    expect(sqlTexts.length).toBeGreaterThan(0);
    const mainQuery = sqlTexts[0];
    expect(mainQuery).toMatch(/to_char\(ci\.invoice_date, 'YYYY-MM-DD'\)\s+AS\s+invoice_date/);
    expect(mainQuery).toMatch(/to_char\(ci\.due_date, 'YYYY-MM-DD'\)\s+AS\s+due_date/);
    // The SELECT list must not expose the raw DATE columns (ORDER BY may still
    // reference ci.invoice_date — only the projection matters for the wire).
    const selectList = mainQuery.slice(0, mainQuery.indexOf('FROM'));
    expect(selectList).not.toMatch(/(?<!to_char\()ci\.invoice_date\s*,/);
    expect(selectList).not.toMatch(/(?<!to_char\()ci\.due_date\s*,/);
  });

  it('detail GET serializes all four DATE columns via to_char in SQL', async () => {
    await (detailHandler as Function)(makeReq({ id: INVOICE_ID }), makeRes());

    expect(sqlTexts.length).toBeGreaterThan(0);
    const detailQuery = sqlTexts[0];
    expect(detailQuery).toMatch(/to_char\(ci\.invoice_date, 'YYYY-MM-DD'\)\s+AS\s+invoice_date/);
    expect(detailQuery).toMatch(/to_char\(ci\.due_date, 'YYYY-MM-DD'\)\s+AS\s+due_date/);
    expect(detailQuery).toMatch(
      /to_char\(ci\.billing_period_start, 'YYYY-MM-DD'\)\s+AS\s+billing_period_start/,
    );
    expect(detailQuery).toMatch(
      /to_char\(ci\.billing_period_end, 'YYYY-MM-DD'\)\s+AS\s+billing_period_end/,
    );

    const selectList = detailQuery.slice(0, detailQuery.indexOf('FROM'));
    expect(selectList).not.toMatch(/(?<!to_char\()ci\.invoice_date\s*,/);
    expect(selectList).not.toMatch(/(?<!to_char\()ci\.due_date\s*,/);
    expect(selectList).not.toMatch(/(?<!to_char\()ci\.billing_period_start\s*,/);
    expect(selectList).not.toMatch(/(?<!to_char\()ci\.billing_period_end\s*,/);
  });
});
