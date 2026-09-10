/**
 * Unit tests for transactionReportingService.ts
 *
 * Regression guard: getCustomerReport and getSupplierReport must scope all
 * queries to the caller's company_id to prevent cross-tenant data dumps.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
      return { _isSqlFragment: true, values };
    }),
    {
      unsafe: vi.fn((s: string) => s),
    }
  );
  return { sql: sqlMock };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// The as-at rewind (R-059) is built from nested sql fragments that would each
// consume one of the queued results below; its arithmetic is pinned against a
// database in tests/integration/r059-period-reports-as-at-period-end.int.test.ts.
vi.mock('@/modules/accounting/services/shared/agingRewind', () => ({
  rewindAmount: vi.fn(() => 'REWIND'),
  effectivePaidExpr: vi.fn(() => 'PAID'),
}));

// Re-export stubs so the barrel re-exports in transactionReportingService don't
// try to import from the real GL service (which has its own DB dependencies).
vi.mock('@/modules/accounting/services/gl/transactionLedgerService', () => ({
  getBankTransactions: vi.fn(),
  getAccountTransactions: vi.fn(),
  getAuditTrail: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  getCustomerReport,
  getSupplierReport,
} from '@/modules/accounting/services/reports/transactionReportingService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-03-31';

function flatSqlValues(sqlMock: ReturnType<typeof vi.fn>): unknown[] {
  return sqlMock.mock.calls.flatMap((callArgs: unknown[]) => {
    const [, ...values] = callArgs;
    return values.flat();
  });
}

// ── getCustomerReport ─────────────────────────────────────────────────────────

describe('getCustomerReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes query to companyId — company_id appears in interpolated SQL values', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      {
        client_id: 'cus-uuid-001',
        client_name: 'Acme Corp',
        invoice_count: '2',
        total_invoiced: '5000.00',
        total_paid: '3000.00',
      },
    ] as never);

    const rows = await getCustomerReport(COMPANY_ID, PERIOD_START, PERIOD_END);

    // Result is correctly mapped
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe('cus-uuid-001');
    expect(rows[0]!.balance).toBeCloseTo(2000, 2);

    // The companyId must have been passed as a parameterised value to the sql
    // tagged template — not baked into a string via concatenation.
    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(COMPANY_ID);
  });

  it('returns an empty array when the query returns no rows', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const rows = await getCustomerReport(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(rows).toEqual([]);
    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(COMPANY_ID);
  });

  it('propagates sql errors to the caller', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('query failed') as never);

    await expect(getCustomerReport(COMPANY_ID, PERIOD_START, PERIOD_END))
      .rejects.toThrow('query failed');
  });
});

// ── getSupplierReport ─────────────────────────────────────────────────────────

describe('getSupplierReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes query to companyId — company_id appears in interpolated SQL values', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      {
        supplier_id: 'sup-uuid-001',
        supplier_name: 'Widget Supplies',
        invoice_count: '3',
        total_invoiced: '12000.00',
        total_paid: '8000.00',
      },
    ] as never);

    const rows = await getSupplierReport(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.supplierId).toBe('sup-uuid-001');
    expect(rows[0]!.balance).toBeCloseTo(4000, 2);

    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(COMPANY_ID);
  });

  it('returns an empty array when the query returns no rows', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const rows = await getSupplierReport(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(rows).toEqual([]);
    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(COMPANY_ID);
  });

  it('propagates sql errors to the caller', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('timeout') as never);

    await expect(getSupplierReport(COMPANY_ID, PERIOD_START, PERIOD_END))
      .rejects.toThrow('timeout');
  });
});
