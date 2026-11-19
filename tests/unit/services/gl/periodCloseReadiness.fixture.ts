/** Shared setup for the periodCloseReadiness* unit suites (split from periodCloseReadinessService.test.ts). */
import type { MockedFunction } from 'vitest';
import { vi } from 'vitest';
import { sql } from '@/lib/neon';
import { getFiscalPeriodById } from '@/modules/accounting/services/gl/fiscalPeriodService';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';
import {
  reconcileSubledger,
  type SubledgerReconciliation,
} from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';

export type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
export type GetPeriodFn = MockedFunction<(companyId: string, id: string) => Promise<FiscalPeriod | null>>;

export const mockSql = sql as unknown as SqlFn;
export const mockGetPeriodById = getFiscalPeriodById as GetPeriodFn;
export const mockReconcile = vi.mocked(reconcileSubledger);

/** A reconciliation where the subledger ties to the control account exactly. */
export function tiedReconciliation(role: string, asAt: string): SubledgerReconciliation {
  return {
    subledger: role as SubledgerReconciliation['subledger'],
    as_at: asAt,
    agedTotal: 1000,
    subledgerTotal: 1000,
    subledgerUnavailable: null,
    controlAccounts: [],
    controlAccountBalance: 1000,
    controlAccountAmbiguous: false,
    difference: 0,
    reconcilingItems: [],
    unexplainedDifference: 0,
    excludedRows: [],
    settlementFlagged: {} as SubledgerReconciliation['settlementFlagged'],
    invariants: [],
    postedThrough: null,
  };
}

export const COMPANY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const COMPANY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const PERIOD_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

export function makePeriod(overrides: Partial<FiscalPeriod> = {}): FiscalPeriod {
  return {
    id: PERIOD_ID,
    periodName: 'January 2026',
    periodNumber: 1,
    fiscalYear: 2026,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Sets up mocks for the SQL checks in SEQUENTIAL execution order. The checks
 * run one-at-a-time (each inside its own savepoint). The ar/ap ties issue no
 * direct SQL — they call the (mocked) reconcileSubledger — so the order is:
 *  Call 1: bank       (1 query)
 *  Call 2: journals   (1 query)
 *  Call 3: vat        (1 query)
 *  Call 4-7: tb — this period's postings, then getTrialBalanceReport's
 *             period basis, balances and brought-forward profit (4 queries;
 *             its fiscal years come from the mocked registry, not sql)
 *  Call 8: opening balance equity (1 query)
 *  Call 9: orphan period journals (1 query)
 */
export function mockAllChecksPass(): void {
  mockSql
    .mockResolvedValueOnce([{ unreconciled_count: '0' }])  // bank
    .mockResolvedValueOnce([{ draft_count: '0' }])         // journals
    .mockResolvedValueOnce([{ vat_count: '1' }])           // vat
    // tb — this period's postings, then the report itself
    .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
    .mockResolvedValueOnce([{ start_date: '2026-02-01', end_date: '2026-02-28' }])
    .mockResolvedValueOnce([
      { account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit',
        closing_debit: '10000.00', closing_credit: '0', period_debit: '10000.00', period_credit: '0' },
      { account_code: '2001', account_name: 'Creditors', account_type: 'liability', normal_balance: 'credit',
        closing_debit: '0', closing_credit: '10000.00', period_debit: '0', period_credit: '10000.00' },
    ])
    .mockResolvedValueOnce([{ retained: '0' }])
    .mockResolvedValueOnce([{ accounts: '0', balance: '0' }]) // opening balance equity
    .mockResolvedValueOnce([{ orphan_count: '0', earliest: null, latest: null, total: '0' }])
}

