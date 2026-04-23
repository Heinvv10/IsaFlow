/**
 * Unit tests for readReceiptService.ts — PRD-06 Phase 2.
 *
 * Verifies:
 *   1. logCustomerInvoiceView inserts one row with company + invoice scoping
 *      and the correct view_source / session_token hash / optional IP+UA.
 *   2. logCustomerInvoiceView swallows DB errors (never throws into the caller
 *      path — a customer-facing portal view must not 500 on a logging failure).
 *   3. listInvoiceViews scopes by company_id and caps the limit at 500.
 *   4. getLastViewedSummary short-circuits on an empty invoice id array.
 *   5. getLastViewedSummary returns a Map keyed by invoice id.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  getLastViewedSummary,
  listInvoiceViews,
  logCustomerInvoiceView,
} from '@/modules/accounting/services/ar/readReceiptService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_INVOICE_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logCustomerInvoiceView', () => {
  it('inserts a row with company + invoice scoping and the supplied metadata', async () => {
    mockSql.mockResolvedValueOnce([]);

    await logCustomerInvoiceView({
      invoiceId: INVOICE_ID,
      companyId: COMPANY_ID,
      viewSource: 'portal',
      sessionTokenHash: 'hash-of-token',
      ipAddress: '196.25.1.1',
      userAgent: 'Mozilla/5.0',
      responseTimeMs: 42,
    });

    expect(mockSql).toHaveBeenCalledOnce();
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain(COMPANY_ID);
    expect(values).toContain(INVOICE_ID);
    expect(values).toContain('portal');
    expect(values).toContain('hash-of-token');
    expect(values).toContain('196.25.1.1');
    expect(values).toContain('Mozilla/5.0');
    expect(values).toContain(42);
  });

  it('accepts nullable ip/ua/session without blowing up', async () => {
    mockSql.mockResolvedValueOnce([]);

    await expect(
      logCustomerInvoiceView({
        invoiceId: INVOICE_ID,
        companyId: COMPANY_ID,
        viewSource: 'tracking_pixel',
      }),
    ).resolves.toBeUndefined();

    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain('tracking_pixel');
    expect(values).toContain(null);
  });

  it('never throws when the DB insert fails — logs warn and returns', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));

    await expect(
      logCustomerInvoiceView({
        invoiceId: INVOICE_ID,
        companyId: COMPANY_ID,
        viewSource: 'api',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('listInvoiceViews', () => {
  it('scopes the query by company_id + invoice_id and maps rows', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 'view-1',
        viewed_at: new Date('2026-04-23T09:00:00Z'),
        view_source: 'portal',
        ip_address: '196.25.1.1',
        user_agent: 'UA',
        session_token: 'hash',
        response_time_ms: 20,
      },
    ]);

    const rows = await listInvoiceViews(INVOICE_ID, COMPANY_ID, 10);

    expect(rows).toEqual([
      {
        id: 'view-1',
        viewedAt: '2026-04-23T09:00:00.000Z',
        viewSource: 'portal',
        ipAddress: '196.25.1.1',
        userAgent: 'UA',
        sessionTokenHash: 'hash',
        responseTimeMs: 20,
      },
    ]);

    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain(COMPANY_ID);
    expect(values).toContain(INVOICE_ID);
  });

  it('caps the LIMIT at 500', async () => {
    mockSql.mockResolvedValueOnce([]);
    await listInvoiceViews(INVOICE_ID, COMPANY_ID, 999999);
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain(500);
  });
});

describe('getLastViewedSummary', () => {
  it('short-circuits to an empty Map when no invoice ids are supplied', async () => {
    const result = await getLastViewedSummary(COMPANY_ID, []);
    expect(result.size).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns a Map keyed by invoice id', async () => {
    mockSql.mockResolvedValueOnce([
      {
        customer_invoice_id: INVOICE_ID,
        last_viewed_at: new Date('2026-04-23T09:00:00Z'),
        view_count: 3,
        distinct_sessions: 2,
      },
      {
        customer_invoice_id: OTHER_INVOICE_ID,
        last_viewed_at: null,
        view_count: 0,
        distinct_sessions: 0,
      },
    ]);

    const map = await getLastViewedSummary(COMPANY_ID, [INVOICE_ID, OTHER_INVOICE_ID]);

    expect(map.size).toBe(2);
    expect(map.get(INVOICE_ID)).toMatchObject({
      invoiceId: INVOICE_ID,
      lastViewedAt: '2026-04-23T09:00:00.000Z',
      viewCount: 3,
      distinctSessions: 2,
    });
    expect(map.get(OTHER_INVOICE_ID)).toMatchObject({
      invoiceId: OTHER_INVOICE_ID,
      lastViewedAt: null,
      viewCount: 0,
      distinctSessions: 0,
    });
  });
});
