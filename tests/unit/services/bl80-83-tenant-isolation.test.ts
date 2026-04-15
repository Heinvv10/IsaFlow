/**
 * Integration-style unit tests for BL-80..BL-83
 * P1 tenant-isolation supplemental guards
 *
 * These tests use mocked sql/neon to verify that the correct company_id guards
 * are present in each affected query branch, and that purgeExpiredDeletes emits
 * per-tenant structured log entries.
 *
 * UUID prefixes:
 *   b181 — BL-81 (getBankTransactions reconciliationId branch)
 *   b182 — BL-82 (startReconciliation bank_transactions UPDATE)
 *   b183 — BL-83 (completeReconciliation bank_transactions UPDATE)
 *   b180 — BL-80 (purgeExpiredDeletes per-tenant log)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock references (hoisted so vi.mock factories can reference them) ──

const { sqlMock, logMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(
    vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      return { _isSqlFragment: true };
    }),
    { unsafe: vi.fn(() => '') }
  );
  const logMock = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  return { sqlMock, logMock };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: logMock }));

// ── Additional mocks required by bankReconciliationService ────────────────────
vi.mock('@/modules/accounting/utils/autoMatch', () => ({
  runAutoMatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/bank/bankTransactionQueryService')>();
  return { ...actual };
});

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import {
  startReconciliation,
  completeReconciliation,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { purgeExpiredDeletes } from '@/modules/accounting/services/core/softDeleteService';

// ── UUID fixtures ─────────────────────────────────────────────────────────────

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

// BL-81 UUIDs (prefix b181)
const B181_RECON_ID = 'b1810000-0000-0000-0000-000000000001';

// BL-82 UUIDs (prefix b182)
const B182_BANK_ACCOUNT_ID = 'b1820000-0000-0000-0000-000000000001';

// BL-83 UUIDs (prefix b183)
const B183_RECON_ID = 'b1830000-0000-0000-0000-000000000001';

// BL-80 UUIDs (prefix b180)
const B180_COMPANY_A = 'b1800000-0000-0000-0000-aaaaaaaaaaaa';
const B180_COMPANY_B = 'b1800000-0000-0000-0000-bbbbbbbbbbbb';

// ── Helper: collect all sql() call argument values ────────────────────────────

function flatSqlValues(): unknown[] {
  return vi.mocked(sql).mock.calls.flatMap((callArgs: unknown[]) => {
    const [, ...values] = callArgs;
    return values.flat();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BL-81: getBankTransactions reconciliationId branch scoped by company_id
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-81: getBankTransactions — reconciliationId must be scoped by company_id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes companyId as a SQL value when reconciliationId filter is used', async () => {
    // COMPANY_A queries with COMPANY_B's reconciliation_id
    // The fix ensures COMPANY_A's company_id is added to the WHERE clause,
    // so COMPANY_B's transactions are never returned.
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)         // rows — empty (correct tenant isolation)
      .mockResolvedValueOnce([{ cnt: '0' }] as never); // countRows

    const result = await getBankTransactions(COMPANY_A, {
      reconciliationId: B181_RECON_ID,
    });

    // Cross-tenant query returns zero results
    expect(result.transactions).toHaveLength(0);
    expect(result.total).toBe(0);

    // Both company_id AND reconciliation_id must appear in the SQL values
    const values = flatSqlValues();
    expect(values).toContain(COMPANY_A);
    expect(values).toContain(B181_RECON_ID);
  });

  it('isolates COMPANY_A results when reconciliationId belongs to COMPANY_B', async () => {
    // Simulate DB correctly returning empty for the cross-tenant query
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ cnt: '0' }] as never);

    const result = await getBankTransactions(COMPANY_A, {
      reconciliationId: B181_RECON_ID,
    });

    expect(result.transactions).toHaveLength(0);

    // Verify the WHERE clause received COMPANY_A — not COMPANY_B
    const values = flatSqlValues();
    expect(values).toContain(COMPANY_A);
    expect(values).not.toContain(COMPANY_B);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BL-82: startReconciliation bank_transactions UPDATE scoped by company_id
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-82: startReconciliation — bank_transactions UPDATE must include company_id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes companyId into the bank_transactions UPDATE inside the transaction', async () => {
    const reconRow = {
      id: B182_BANK_ACCOUNT_ID,
      company_id: COMPANY_A,
      bank_account_id: B182_BANK_ACCOUNT_ID,
      statement_date: '2026-03-31',
      statement_balance: 10000,
      gl_balance: 10000,
      reconciled_balance: 10000,
      status: 'open',
      difference: 0,
      started_by: 'user-uuid',
      completed_by: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      bank_account_name: null,
      matched_count: 0,
      unmatched_count: 0,
    };

    // sql() for gl_balance query
    vi.mocked(sql).mockResolvedValueOnce([{ gl_balance: '10000' }] as never);

    // withTransaction captures the callback and executes it
    vi.mocked(withTransaction).mockImplementationOnce(async (cb: (tx: typeof sql) => Promise<unknown>) => {
      // Create a transaction-scoped sql mock that captures calls
      const txMock = Object.assign(
        vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
          // First tx call: INSERT RETURNING
          if (txMock.mock.calls.length === 1) return Promise.resolve([reconRow]);
          // Second tx call: UPDATE bank_transactions
          return Promise.resolve([]);
        }),
        { unsafe: vi.fn(() => '') }
      );
      const result = await cb(txMock as unknown as typeof sql);

      // Verify the UPDATE call included companyId
      const updateCall = txMock.mock.calls[1];
      expect(updateCall).toBeDefined();
      const updateValues = updateCall ? updateCall.slice(1).flat() : [];
      expect(updateValues).toContain(COMPANY_A);

      return result;
    });

    await startReconciliation(COMPANY_A, B182_BANK_ACCOUNT_ID, '2026-03-31', 10000, 'user-uuid');

    // withTransaction was called
    expect(vi.mocked(withTransaction)).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BL-83: completeReconciliation bank_transactions UPDATE scoped by company_id
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-83: completeReconciliation — bank_transactions UPDATE must include company_id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes companyId into the SET status=reconciled UPDATE', async () => {
    const completedRow = {
      id: B183_RECON_ID,
      company_id: COMPANY_A,
      bank_account_id: 'ba-uuid',
      statement_date: '2026-03-31',
      statement_balance: 10000,
      gl_balance: 10000,
      reconciled_balance: 10000,
      status: 'completed',
      difference: 0,
      started_by: 'user-uuid',
      completed_by: 'user-uuid',
      completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      bank_account_name: null,
      matched_count: 0,
      unmatched_count: 0,
    };

    // getReconciliationById (called internally) — returns an open recon with difference=0
    vi.mocked(sql).mockResolvedValueOnce([{
      ...completedRow,
      status: 'open',
      difference: 0,
      matched_count: '2',
      unmatched_count: '0',
    }] as never);

    vi.mocked(withTransaction).mockImplementationOnce(async (cb: (tx: typeof sql) => Promise<unknown>) => {
      const txMock = Object.assign(
        vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
          // First call: UPDATE bank_transactions SET status='reconciled'
          if (txMock.mock.calls.length === 1) return Promise.resolve([]);
          // Second call: UPDATE bank_reconciliations SET status='completed'
          return Promise.resolve([completedRow]);
        }),
        { unsafe: vi.fn(() => '') }
      );
      const result = await cb(txMock as unknown as typeof sql);

      // Verify the first UPDATE (bank_transactions) included companyId
      const firstUpdateCall = txMock.mock.calls[0];
      expect(firstUpdateCall).toBeDefined();
      const firstUpdateValues = firstUpdateCall ? firstUpdateCall.slice(1).flat() : [];
      expect(firstUpdateValues).toContain(COMPANY_A);

      return result;
    });

    await completeReconciliation(COMPANY_A, B183_RECON_ID, 'user-uuid');

    expect(vi.mocked(withTransaction)).toHaveBeenCalledOnce();
  });

  it('does not affect COMPANY_B transactions when completing COMPANY_A reconciliation', async () => {
    // If COMPANY_B has matched transactions under the same reconciliation_id
    // (cross-tenant collision scenario), company_id guard prevents them from
    // being marked reconciled.
    //
    // This test verifies that companyId is passed as a SQL value — the DB-level
    // guard enforces isolation. We verify the value is present in the UPDATE call.

    const reconRow = {
      id: B183_RECON_ID,
      company_id: COMPANY_A,
      bank_account_id: 'ba-uuid',
      statement_date: '2026-03-31',
      statement_balance: 5000,
      gl_balance: 5000,
      reconciled_balance: 5000,
      status: 'open',
      difference: 0,
      started_by: 'user-uuid',
      completed_by: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      bank_account_name: null,
      matched_count: '1',
      unmatched_count: '0',
    };

    vi.mocked(sql).mockResolvedValueOnce([reconRow] as never);

    let capturedFirstUpdateValues: unknown[] = [];

    vi.mocked(withTransaction).mockImplementationOnce(async (cb: (tx: typeof sql) => Promise<unknown>) => {
      const txMock = Object.assign(
        vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
          if (txMock.mock.calls.length === 1) {
            capturedFirstUpdateValues = _values.flat();
            return Promise.resolve([]);
          }
          return Promise.resolve([{ ...reconRow, status: 'completed', completed_by: 'user-uuid', completed_at: new Date().toISOString() }]);
        }),
        { unsafe: vi.fn(() => '') }
      );
      return await cb(txMock as unknown as typeof sql);
    });

    await completeReconciliation(COMPANY_A, B183_RECON_ID, 'user-uuid');

    // COMPANY_A's id is in the UPDATE values; COMPANY_B is not
    expect(capturedFirstUpdateValues).toContain(COMPANY_A);
    expect(capturedFirstUpdateValues).not.toContain(COMPANY_B);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BL-80: purgeExpiredDeletes emits per-tenant structured log entries
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-80: purgeExpiredDeletes — per-tenant structured logging', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits log.info with { table, companyIds, rowCount } when rows are deleted', async () => {
    // Simulate two deleted rows from two different tenants for customers table
    // then empty results for all other tables
    const deletedRows = [
      { id: 'row-001', company_id: B180_COMPANY_A },
      { id: 'row-002', company_id: B180_COMPANY_B },
    ];

    // 6 tables — first returns 2 rows, rest return empty
    vi.mocked(sql)
      .mockResolvedValueOnce(deletedRows as never)  // customers
      .mockResolvedValueOnce([] as never)            // suppliers
      .mockResolvedValueOnce([] as never)            // items
      .mockResolvedValueOnce([] as never)            // bank_rules
      .mockResolvedValueOnce([] as never)            // customer_invoices
      .mockResolvedValueOnce([] as never);           // supplier_invoices

    const total = await purgeExpiredDeletes();

    expect(total).toBe(2);

    // log.info must have been called with the per-tenant structure
    expect(vi.mocked(log).info).toHaveBeenCalledWith(
      'Purged expired soft-deletes',
      expect.objectContaining({
        table: 'customer',
        companyIds: expect.arrayContaining([B180_COMPANY_A, B180_COMPANY_B]),
        rowCount: 2,
      }),
      'accounting'
    );
  });

  it('does not call log.info when no rows are deleted (zero-delete run)', async () => {
    // All tables return empty
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    const total = await purgeExpiredDeletes();

    expect(total).toBe(0);
    expect(vi.mocked(log).info).not.toHaveBeenCalled();
  });

  it('deduplicates companyIds in the log entry', async () => {
    // Three rows, all from the same company — companyIds should have length 1
    const sameCompanyRows = [
      { id: 'row-001', company_id: B180_COMPANY_A },
      { id: 'row-002', company_id: B180_COMPANY_A },
      { id: 'row-003', company_id: B180_COMPANY_A },
    ];

    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)            // customers
      .mockResolvedValueOnce(sameCompanyRows as never) // suppliers
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    await purgeExpiredDeletes();

    const infoCall = vi.mocked(log).info.mock.calls[0];
    expect(infoCall).toBeDefined();
    const loggedData = infoCall![1] as { companyIds: string[]; rowCount: number };
    expect(loggedData.companyIds).toHaveLength(1);
    expect(loggedData.rowCount).toBe(3);
  });

  it('runs all 6 tables and continues past errors in individual tables', async () => {
    // suppliers table throws; all others succeed (returning empty)
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)                        // customers
      .mockRejectedValueOnce(new Error('table locked') as never) // suppliers — error
      .mockResolvedValueOnce([] as never)                        // items
      .mockResolvedValueOnce([] as never)                        // bank_rules
      .mockResolvedValueOnce([] as never)                        // customer_invoices
      .mockResolvedValueOnce([] as never);                       // supplier_invoices

    // Should not throw — error is caught and logged per-table
    const total = await purgeExpiredDeletes();

    expect(total).toBe(0);
    expect(vi.mocked(log).error).toHaveBeenCalledWith(
      'Failed to purge expired deletes',
      expect.objectContaining({ entityType: 'supplier' }),
      'accounting'
    );
  });

  it('smoke: purgeExpiredDeletes completes without throwing (no-op run)', async () => {
    // All empty — just verify the function completes normally
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    await expect(purgeExpiredDeletes()).resolves.toBe(0);
  });
});
