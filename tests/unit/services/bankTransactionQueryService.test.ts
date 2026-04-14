/**
 * Unit tests for bankTransactionQueryService — BL-17
 *
 * Verifies that the `status` filter is applied even when `bankAccountId` is
 * absent (company-wide query path).
 *
 * RED PHASE — the first describe block will FAIL until the fix is applied
 * because the current company-wide branch ignores `status` entirely.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
      // Return a tagged-template-compatible fragment for TX_SELECT interpolation
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

import { sql } from '@/lib/neon';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const ACCOUNT_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-uuid-001',
    bank_account_id: ACCOUNT_ID,
    transaction_date: '2026-01-15',
    value_date: null,
    amount: -500,
    description: 'Test transaction',
    reference: null,
    bank_reference: null,
    status: 'imported',
    matched_journal_line_id: null,
    reconciliation_id: null,
    import_batch_id: null,
    exclude_reason: null,
    notes: null,
    suggested_gl_account_id: null,
    suggested_gl_account_name: null,
    suggested_gl_account_code: null,
    suggested_category: null,
    suggested_cost_centre: null,
    suggested_supplier_id: null,
    suggested_supplier_name: null,
    suggested_client_id: null,
    suggested_client_name: null,
    suggested_vat_code: null,
    suggested_confidence: null,
    cc1_id: null,
    cc2_id: null,
    bu_id: null,
    cc1_name: null,
    cc2_name: null,
    bu_name: null,
    allocation_type: null,
    allocated_entity_name: null,
    bank_account_name: 'Test Bank',
    matched_entry_number: null,
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-01-15T08:00:00Z',
    ...overrides,
  };
}

// ── BL-17: status filter without bankAccountId ────────────────────────────────
//
// The sql mock is a vi.fn(). When getBankTransactions calls sql`...${status}...`,
// the tagged template invocation passes (strings, ...values) to the mock.
//
// Before the fix: company-wide branch has NO status param — the mock is called
//   with [companyId] as the only non-string value; status is absent.
// After the fix:  status IS included in the interpolated values of the data query.
//
// We detect this by inspecting the flattened values of all sql() calls.

function flatSqlValues(sqlMock: ReturnType<typeof vi.fn>): unknown[] {
  return sqlMock.mock.calls.flatMap((callArgs: unknown[]) => {
    // Tagged template: callArgs = [TemplateStringsArray, ...values]
    // Nested fragments: callArgs[0] might be a sql fragment object from TX_SELECT
    const [, ...values] = callArgs;
    return values.flat();
  });
}

describe('getBankTransactions — BL-17: status filter without bankAccountId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the status value to the SQL query when only status is provided', async () => {
    // Arrange: mock returns 3 imported rows + count
    const importedRows = [
      makeTxRow({ id: 'tx-001', status: 'imported' }),
      makeTxRow({ id: 'tx-002', status: 'imported' }),
      makeTxRow({ id: 'tx-003', status: 'imported' }),
    ];
    vi.mocked(sql)
      .mockResolvedValueOnce(importedRows as never)
      .mockResolvedValueOnce([{ cnt: '3' }] as never);

    // Act
    const result = await getBankTransactions(COMPANY_ID, { status: 'imported' });

    // Assert output shape
    expect(result.transactions).toHaveLength(3);
    expect(result.total).toBe(3);
    result.transactions.forEach(tx => expect(tx.status).toBe('imported'));

    // Assert the status value was actually passed to the SQL layer.
    // Before BL-17 fix: company-wide branch omits status → this assertion FAILS.
    // After fix: status param is present → assertion PASSES.
    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain('imported');
  });

  it('passes status=matched to the SQL query (no bankAccountId)', async () => {
    const matchedRows = [
      makeTxRow({ id: 'tx-020', status: 'matched' }),
      makeTxRow({ id: 'tx-021', status: 'matched' }),
    ];
    vi.mocked(sql)
      .mockResolvedValueOnce(matchedRows as never)
      .mockResolvedValueOnce([{ cnt: '2' }] as never);

    await getBankTransactions(COMPANY_ID, { status: 'matched' });

    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain('matched');
  });

  it('returns all results when no status provided (existing behaviour preserved)', async () => {
    const mixedRows = [
      makeTxRow({ id: 'tx-030', status: 'imported' }),
      makeTxRow({ id: 'tx-031', status: 'matched' }),
      makeTxRow({ id: 'tx-032', status: 'excluded' }),
    ];
    vi.mocked(sql)
      .mockResolvedValueOnce(mixedRows as never)
      .mockResolvedValueOnce([{ cnt: '3' }] as never);

    const result = await getBankTransactions(COMPANY_ID);

    expect(result.transactions).toHaveLength(3);
    expect(result.total).toBe(3);
  });
});

// ── Backwards-compatible: bankAccountId + status branch ───────────────────────

describe('getBankTransactions — bankAccountId + status branch (backwards compat)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('filters by status when both bankAccountId and status are provided', async () => {
    const importedRows = [
      makeTxRow({ id: 'tx-100', status: 'imported' }),
      makeTxRow({ id: 'tx-101', status: 'allocated' }),
    ];
    vi.mocked(sql)
      .mockResolvedValueOnce(importedRows as never)
      .mockResolvedValueOnce([{ cnt: '2' }] as never);

    const result = await getBankTransactions(COMPANY_ID, {
      bankAccountId: ACCOUNT_ID,
      status: 'imported',
    });

    expect(result.transactions).toHaveLength(2);
    expect(result.total).toBe(2);

    // Status AND bankAccountId must both appear in sql values
    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain('imported');
  });

  it('returns all transactions for an account when only bankAccountId is given', async () => {
    const rows = [
      makeTxRow({ id: 'tx-200', status: 'imported' }),
      makeTxRow({ id: 'tx-201', status: 'matched' }),
    ];
    vi.mocked(sql)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ cnt: '2' }] as never);

    const result = await getBankTransactions(COMPANY_ID, { bankAccountId: ACCOUNT_ID });

    expect(result.transactions).toHaveLength(2);
    expect(result.total).toBe(2);
  });
});
