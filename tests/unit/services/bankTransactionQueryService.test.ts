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
    excluded_reason: null,
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

// ── Capture attach sheet: search filter without bankAccountId ─────────────────
//
// The company-wide (final else) branch previously ignored `search`, so the
// attach-to-transaction sheet's search box was dead. After the fix the ILIKE
// pattern must be passed as a parameterised value to BOTH queries.

describe('getBankTransactions — search filter without bankAccountId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the ILIKE search pattern to the SQL query when only search is provided', async () => {
    const rows = [makeTxRow({ id: 'tx-s-001', description: 'Coffee shop' })];
    vi.mocked(sql)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getBankTransactions(COMPANY_ID, { search: 'coffee' });

    expect(result.transactions).toHaveLength(1);
    expect(result.total).toBe(1);

    // The wrapped pattern must appear in the data query AND the count query.
    const dataValues = vi.mocked(sql).mock.calls[0]!.slice(1).flat();
    const countValues = vi.mocked(sql).mock.calls[1]!.slice(1).flat();
    expect(dataValues).toContain('%coffee%');
    expect(countValues).toContain('%coffee%');
  });

  it('passes a NULL pattern when no search is provided (condition collapses to TRUE, keeping NULL-description rows)', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([makeTxRow()] as never)
      .mockResolvedValueOnce([{ cnt: '1' }] as never);

    await getBankTransactions(COMPANY_ID);

    // The pattern is null when no search term is given — no ILIKE pattern of
    // any kind may reach the SQL layer (a bare '%' would drop rows where both
    // description and reference are NULL).
    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(null);
    const likePatterns = allValues.filter(
      (v): v is string => typeof v === 'string' && v.includes('%')
    );
    expect(likePatterns).toHaveLength(0);
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
    expect(flatSqlValues(vi.mocked(sql))).toContain(ACCOUNT_ID);
  });
});

// ── BL-11: Limit cap + explicit column projection ─────────────────────────────

describe('getBankTransactions — BL-11: limit cap at 100', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps limit=500 to 100 — service returns at most 100 rows', async () => {
    // Simulate DB returning 100 rows (the capped amount)
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeTxRow({ id: `tx-cap-${String(i).padStart(3, '0')}`, status: 'imported' })
    );
    vi.mocked(sql)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ cnt: '150' }] as never);

    const result = await getBankTransactions(COMPANY_ID, { limit: 500 });

    // Regardless of what the caller requested, the response must be ≤ 100
    expect(result.transactions.length).toBeLessThanOrEqual(100);
    expect(result.total).toBe(150);

    // The limit value passed to sql must be capped to 100 (not 500)
    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(100);
    expect(allValues).not.toContain(500);
  });

  it('caps limit=200 to 100', async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeTxRow({ id: `tx-cap200-${String(i).padStart(3, '0')}` })
    );
    vi.mocked(sql)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ cnt: '200' }] as never);

    await getBankTransactions(COMPANY_ID, { limit: 200 });

    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(100);
    expect(allValues).not.toContain(200);
  });

  it('allows limit=50 unchanged (under cap)', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      makeTxRow({ id: `tx-50-${String(i).padStart(3, '0')}` })
    );
    vi.mocked(sql)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ cnt: '50' }] as never);

    await getBankTransactions(COMPANY_ID, { limit: 50 });

    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(50);
  });
});

// ── IDOR fix: bankAccountId branches must include company_id ─────────────────
//
// Before the fix the bankAccountId and bankAccountId+status branches omitted
// company_id, allowing any authenticated user to read transactions from another
// tenant's bank account by guessing the account UUID.

describe('getBankTransactions — IDOR: company_id present in bankAccountId branches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes companyId to sql when bankAccountId + status are provided', async () => {
    const rows = [makeTxRow({ id: 'tx-idor-001', status: 'imported' })];
    vi.mocked(sql)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ cnt: '1' }] as never);

    await getBankTransactions(COMPANY_ID, {
      bankAccountId: ACCOUNT_ID,
      status: 'imported',
    });

    const allValues = flatSqlValues(vi.mocked(sql));
    // Both the bank account ID and the company ID must appear as parameterised
    // values — not just the account ID (which was the pre-fix behaviour).
    expect(allValues).toContain(ACCOUNT_ID);
    expect(allValues).toContain(COMPANY_ID);
  });

  it('passes companyId to sql when only bankAccountId is provided', async () => {
    const rows = [makeTxRow({ id: 'tx-idor-002' })];
    vi.mocked(sql)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ cnt: '1' }] as never);

    await getBankTransactions(COMPANY_ID, { bankAccountId: ACCOUNT_ID });

    const allValues = flatSqlValues(vi.mocked(sql));
    expect(allValues).toContain(ACCOUNT_ID);
    expect(allValues).toContain(COMPANY_ID);
  });
});

describe('getBankTransactions — BL-11: mapTxRow column projection regression guard', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Regression guard: every key that mapTxRow reads from a DB row must be
   * present in makeTxRow (our canonical fixture). If a column is accidentally
   * dropped from TX_SELECT, mapTxRow will receive undefined and the mapped
   * field will silently become undefined. This test verifies the full
   * mapper output shape matches expected keys.
   */
  it('maps all expected BankTransaction fields from a complete row', async () => {
    const row = makeTxRow({
      value_date: '2026-01-16',
      bank_reference: 'BR-001',
      matched_journal_line_id: 'jl-uuid-001',
      reconciliation_id: 'rec-uuid-001',
      import_batch_id: 'batch-uuid-001',
      excluded_reason: 'duplicate',
      notes: 'test note',
      suggested_gl_account_id: 'ga-uuid-001',
      suggested_gl_account_name: 'Bank Charges',
      suggested_gl_account_code: '7200',
      suggested_category: 'expenses',
      suggested_supplier_id: 'sup-uuid-001',
      suggested_supplier_name: 'ACME Ltd',
      suggested_client_id: 'cli-uuid-001',
      suggested_client_name: 'Client Corp',
      suggested_vat_code: 'S',
      suggested_confidence: 0.95,
      cc1_id: 'cc1-uuid',
      cc2_id: 'cc2-uuid',
      bu_id: 'bu-uuid',
      allocation_type: 'supplier',
      allocated_entity_name: 'ACME Ltd',
    });
    vi.mocked(sql)
      .mockResolvedValueOnce([row] as never)
      .mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getBankTransactions(COMPANY_ID);
    expect(result.transactions).toHaveLength(1);

    const tx = result.transactions[0]!;

    // Core identity and amounts
    expect(tx.id).toBe('tx-uuid-001');
    expect(tx.bankAccountId).toBe(ACCOUNT_ID);
    expect(tx.amount).toBe(-500);
    expect(tx.status).toBe('imported');

    // Dates
    expect(tx.transactionDate).toBe('2026-01-15');
    expect(tx.valueDate).toBe('2026-01-16');

    // Optional text fields
    expect(tx.bankReference).toBe('BR-001');
    expect(tx.excludeReason).toBe('duplicate');
    expect(tx.notes).toBe('test note');

    // Suggestion fields
    expect(tx.suggestedGlAccountId).toBe('ga-uuid-001');
    expect(tx.suggestedGlAccountName).toBe('Bank Charges');
    expect(tx.suggestedGlAccountCode).toBe('7200');
    expect(tx.suggestedCategory).toBe('expenses');
    expect(tx.suggestedSupplierId).toBe('sup-uuid-001');
    expect(tx.suggestedSupplierName).toBe('ACME Ltd');
    expect(tx.suggestedClientId).toBe('cli-uuid-001');
    expect(tx.suggestedClientName).toBe('Client Corp');
    expect(tx.suggestedVatCode).toBe('S');
    expect(tx.suggestedConfidence).toBeCloseTo(0.95);

    // Cost centre / BU
    expect(tx.cc1Id).toBe('cc1-uuid');
    expect(tx.cc2Id).toBe('cc2-uuid');
    expect(tx.buId).toBe('bu-uuid');

    // Allocation
    expect(tx.allocationType).toBe('supplier');
    expect(tx.allocatedEntityName).toBe('ACME Ltd');

    // Join-provided fields
    expect(tx.bankAccountName).toBe('Test Bank');
  });
});

// ── Issue #256: allocationFilter + dates ignored outside the account+status branch ─
//
// Rows query and count query are separate sql`` calls (call 0 = rows, call 1 =
// count). Each assertion below inspects ONE call so a predicate dropped from
// either query alone is caught.

// PRD-11 §2: allocated ⇔ a posted journal line exists. Suggestions are NOT allocations.
const ALLOC_NULL = 'bt.matched_journal_line_id IS NULL';
const ALLOC_NOT_NULL = 'bt.matched_journal_line_id IS NOT NULL';

/** Reconstruct the SQL text of the Nth sql`` call, with unsafe fragments inlined. */
function sqlTextOf(callIdx: number): string {
  const call = vi.mocked(sql).mock.calls[callIdx];
  if (!call) throw new Error(`no sql call #${callIdx}`);
  const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
  return strings.map((str, i) => str + (i < values.length ? (typeof values[i] === 'string' ? values[i] : '?') : '')).join('');
}
function valuesOf(callIdx: number): unknown[] {
  const call = vi.mocked(sql).mock.calls[callIdx];
  if (!call) throw new Error(`no sql call #${callIdx}`);
  return (call as unknown[]).slice(1);
}

describe('getBankTransactions — #256: allocationFilter applied in every branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sql).mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ cnt: '0' }] as never);
  });

  it('applies unallocated predicate to rows AND count with bankAccountId only (MCP path)', async () => {
    await getBankTransactions(COMPANY_ID, { bankAccountId: ACCOUNT_ID, allocationFilter: 'unallocated' });
    expect(vi.mocked(sql).mock.calls).toHaveLength(2);
    for (const i of [0, 1]) {
      expect(sqlTextOf(i)).toContain(ALLOC_NULL);
      expect(sqlTextOf(i)).not.toContain(ALLOC_NOT_NULL);
    }
  });

  it('applies allocated predicate to rows AND count with bankAccountId only', async () => {
    await getBankTransactions(COMPANY_ID, { bankAccountId: ACCOUNT_ID, allocationFilter: 'allocated' });
    for (const i of [0, 1]) expect(sqlTextOf(i)).toContain(ALLOC_NOT_NULL);
  });

  it('applies allocation predicate and date range to rows AND count with no bankAccountId', async () => {
    await getBankTransactions(COMPANY_ID, {
      allocationFilter: 'unallocated', fromDate: '2026-04-01', toDate: '2026-04-18',
    });
    for (const i of [0, 1]) {
      expect(sqlTextOf(i)).toContain(ALLOC_NULL);
      expect(sqlTextOf(i)).toContain('bt.transaction_date >=');
      expect(valuesOf(i)).toContain('2026-04-01');
      expect(valuesOf(i)).toContain('2026-04-18');
    }
  });

  it('adds no allocation predicate for "all"', async () => {
    await getBankTransactions(COMPANY_ID, { bankAccountId: ACCOUNT_ID, allocationFilter: 'all' });
    for (const i of [0, 1]) expect(sqlTextOf(i)).not.toContain('bt.matched_journal_line_id IS');
  });
});

describe('getBankTransactions — PRD-11: allocation is a posted journal line, not a suggestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sql).mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ cnt: '0' }] as never);
  });

  it('"allocated" never keys on suggested_* columns', async () => {
    await getBankTransactions(COMPANY_ID, { bankAccountId: ACCOUNT_ID, allocationFilter: 'allocated' });
    for (const i of [0, 1]) {
      expect(sqlTextOf(i)).toContain(ALLOC_NOT_NULL);
      expect(sqlTextOf(i)).not.toContain('suggested_gl_account_id IS NOT NULL OR');
    }
  });

  it('"unallocated" excludes suggested rows and excluded rows', async () => {
    await getBankTransactions(COMPANY_ID, { bankAccountId: ACCOUNT_ID, allocationFilter: 'unallocated' });
    for (const i of [0, 1]) {
      const t = sqlTextOf(i);
      expect(t).toContain(ALLOC_NULL);
      expect(t).toContain('bt.suggested_gl_account_id IS NULL');
      expect(t).toContain("bt.status != 'excluded'");
    }
  });

  it('"suggested" = no journal line but a suggestion or saved category', async () => {
    await getBankTransactions(COMPANY_ID, { bankAccountId: ACCOUNT_ID, allocationFilter: 'suggested' });
    for (const i of [0, 1]) {
      const t = sqlTextOf(i);
      expect(t).toContain(ALLOC_NULL);
      expect(t).toContain('bt.suggested_gl_account_id IS NOT NULL OR');
    }
  });
});
