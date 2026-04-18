/**
 * Snapshot tests for customer-invoices-list handler — BL-23
 *
 * Verifies that the consolidated single-query approach correctly handles all
 * four filter dimensions that previously lived in separate SQL branches:
 *   1. No filter        → all company invoices (up to limit)
 *   2. status filter    → only matching-status invoices
 *   3. clientId filter  → only COALESCE(client_id, customer_id) = X rows
 *   4. searchTerm       → invoice_number ILIKE match
 *
 * The sql mock captures interpolated values so we can assert that the correct
 * parameters are passed to the query without hitting the database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ── Mocks must be hoisted before any imports that use them ────────────────────

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Track every sql`` call so we can inspect the interpolated values.
const sqlCalls: unknown[][] = [];

vi.mock('@/lib/neon', () => {
  const mockSql = vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push(values);
    return Promise.resolve([]);
  });
  return { sql: mockSql };
});

// auth middleware — unwrap, injecting companyId via req object
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: Function) => fn,
  withWriteAccess: (fn: Function) => fn,
}));

vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (fn: Function) => fn,
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => data),
    badRequest: vi.fn(),
    methodNotAllowed: vi.fn(),
    databaseError: vi.fn(),
  },
}));

// ── Import handler after mocks ────────────────────────────────────────────────

import handler from '../../../pages/api/accounting/customer-invoices-list';

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY_ID = 'cccccccc-0000-0000-0000-cccccccccccc';
const CLIENT_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

function makeReq(query: Record<string, string | string[]> = {}): NextApiRequest {
  return {
    method: 'GET',
    query,
    // withAuth middleware injects companyId on the request object
    companyId: COMPANY_ID,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse {
  return {} as NextApiResponse;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('customer-invoices-list handler (BL-23)', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    vi.clearAllMocks();
  });

  it('no filter — fires two SQL calls (main + count); all filter params are null', async () => {
    await (handler as Function)(makeReq({ limit: '25' }), makeRes());

    // Two SQL calls: main query + count
    expect(sqlCalls.length).toBe(2);

    // All filter params should be null
    const mainCallValues = sqlCalls[0];
    expect(mainCallValues).toContain(COMPANY_ID);
    // statusValues, clientIdFilter, searchTermFilter should all be null
    const nullCount = mainCallValues.filter((v) => v === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(3);
  });

  it('limit cap — requesting 200 is clamped to 100', async () => {
    await (handler as Function)(makeReq({ limit: '200' }), makeRes());

    const mainCallValues = sqlCalls[0];
    // safeLimit = Math.min(200, 100) = 100
    expect(mainCallValues).toContain(100);
    expect(mainCallValues).not.toContain(200);
  });

  it('status filter — statusValues array [approved] is passed as non-null', async () => {
    await (handler as Function)(makeReq({ status: 'approved' }), makeRes());

    expect(sqlCalls.length).toBe(2);
    const mainCallValues = sqlCalls[0];

    // statusValues should be ['approved']
    const statusArg = mainCallValues.find(
      (v) => Array.isArray(v) && (v as string[]).includes('approved'),
    );
    expect(statusArg).toEqual(['approved']);

    // clientIdFilter should still be null
    expect(mainCallValues).toContain(null);
  });

  it('clientId filter — clientIdFilter uuid is passed, statusValues remains null', async () => {
    await (handler as Function)(makeReq({ client_id: CLIENT_ID }), makeRes());

    expect(sqlCalls.length).toBe(2);
    const mainCallValues = sqlCalls[0];

    expect(mainCallValues).toContain(CLIENT_ID);
    // statusValues array should NOT be present (it is null, not an array)
    const hasStatusArray = mainCallValues.some(
      (v) => Array.isArray(v) && (v as unknown[]).length > 0,
    );
    expect(hasStatusArray).toBe(false);
  });

  it('searchTerm filter — searchTermFilter string is passed for q=INV-001', async () => {
    await (handler as Function)(makeReq({ q: 'INV-001' }), makeRes());

    expect(sqlCalls.length).toBe(2);
    const mainCallValues = sqlCalls[0];

    expect(mainCallValues).toContain('INV-001');
    // statusValues should remain null
    const hasStatusArray = mainCallValues.some(
      (v) => Array.isArray(v) && (v as unknown[]).length > 0,
    );
    expect(hasStatusArray).toBe(false);
  });

  it('combined status + clientId — both non-null, searchTerm null', async () => {
    await (handler as Function)(makeReq({ status: 'sent', client_id: CLIENT_ID }), makeRes());

    expect(sqlCalls.length).toBe(2);
    const mainCallValues = sqlCalls[0];

    const statusArg = mainCallValues.find(
      (v) => Array.isArray(v) && (v as string[]).includes('sent'),
    );
    expect(statusArg).toEqual(['sent']);
    expect(mainCallValues).toContain(CLIENT_ID);
    // searchTermFilter is null
    expect(mainCallValues).toContain(null);
  });

  it('status=all is treated as no filter (statusValues is null, not [all])', async () => {
    await (handler as Function)(makeReq({ status: 'all' }), makeRes());

    expect(sqlCalls.length).toBe(2);
    const mainCallValues = sqlCalls[0];

    // statusValues should be null (not ['all'])
    const hasAllArray = mainCallValues.some(
      (v) => Array.isArray(v) && (v as string[]).includes('all'),
    );
    expect(hasAllArray).toBe(false);
    // null present for all three filters
    expect(mainCallValues).toContain(null);
  });

  it('non-GET method is rejected — no SQL calls fired', async () => {
    const { apiResponse } = await import('@/lib/apiResponse');
    const req = { ...makeReq(), method: 'POST' } as unknown as NextApiRequest;
    await (handler as Function)(req, makeRes());

    expect(sqlCalls.length).toBe(0);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });
});
