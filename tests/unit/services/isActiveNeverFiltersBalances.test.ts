/**
 * `gl_accounts.is_active` must never filter a money query.
 *
 * `is_active` is a chart-of-accounts *picker* flag: it means "stop offering this
 * account when coding new transactions". It says nothing about whether the
 * account still holds money. Using it as a filter inside a balance/total query
 * makes a deactivated account with a live balance silently vanish from cash
 * figures, the AFS and the close checks.
 *
 * Confirmed in production (Brightsphere, 2026-09-03): four inactive accounts
 * carry R137,317.39 between them — 1110 Bank - Primary R6,550.00,
 * 1121 Loan Account - Blitz Fibre R130,000.00, 1140 VAT Input R450.00,
 * 5820 Other Expense R317.39. The same filter had already dropped 1121 from the
 * CaseWare export, leaving it out of balance by exactly R130,000.
 *
 * These tests capture the SQL each service actually issues and assert the
 * predicate is gone. SQL comments are stripped before matching, so an
 * explanatory `-- ... is_active ...` comment cannot make a test pass that the
 * code does not earn.
 *
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockUnsafe } from '../helpers/sqlFragmentMock';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: mockUnsafe });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/reports/consolidatedTrialBalanceService', () => ({
  getGroupMembers: vi.fn(async () => [
    { companyId: COMPANY_A, companyName: 'Alpha', ownershipPct: 100, consolidationMethod: 'full', isHolding: false },
  ]),
}));

import { sql } from '@/lib/neon';
import { getDashboardKPIs } from '@/modules/accounting/services/reports/kpiDashboardService';
import { getCashFlowChart } from '@/modules/accounting/services/reports/kpiChartsService';
import { getGroupDashboardStats } from '@/modules/accounting/services/reports/consolidatedReportingService';
import { getCurrentCashBalance } from '@/modules/accounting/services/reports/cashFlowForecastDataService';
import { openingBalanceEquityCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/openingBalanceEquityCheck';
import { getUnmappedAccounts, getMappingStats } from '@/modules/accounting/services/afs/afsMappingQueries';

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const GROUP_A = 'ggggggg1-0000-0000-0000-000000000001';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

/**
 * Flatten a tagged-template call to its SQL text with comments removed.
 * Stripping `--` line comments and block comments is deliberate: without it an
 * explanatory comment mentioning `is_active` would keep these assertions green
 * while the predicate was quietly reinstated.
 */
function sqlTextOf(args: unknown[]): string {
  const strings = args[0] as readonly string[];
  return strings
    .join(' ? ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ');
}

function issuedQueries(): string[] {
  return sqlMock.mock.calls.map((args) => sqlTextOf(args as unknown[]));
}

function queriesMatching(re: RegExp): string[] {
  return issuedQueries().filter((q) => re.test(q));
}

/** Any use of gl_accounts.is_active as a predicate, whatever the alias. */
const IS_ACTIVE_PREDICATE = /\b[a-z_]*\.?is_active\b/i;

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

describe('is_active never filters a balance query', () => {
  it('kpiDashboardService cash (current and prior period) ignores is_active', async () => {
    await getDashboardKPIs(COMPANY_A, '2026-01-01', '2026-01-31');

    const cashQueries = queriesMatching(/FROM bank_transactions bt/i);
    expect(cashQueries).toHaveLength(2); // current + prior
    for (const q of cashQueries) {
      expect(q).toMatch(/account_subtype = ANY\(\s*[?$]/i); // still restricted to bank accounts
      expect(q).not.toMatch(IS_ACTIVE_PREDICATE);
    }
  });

  it('kpiChartsService cash trend ignores is_active and still restricts to bank accounts', async () => {
    await getCashFlowChart(COMPANY_A, 6);

    const [q] = queriesMatching(/bank_transactions/i);
    expect(q).toBeDefined();
    expect(q!).not.toMatch(IS_ACTIVE_PREDICATE);
    // The bank-subtype restriction must actually exclude non-bank rows. A plain
    // LEFT JOIN onto gl_accounts does not: unmatched bank_transactions rows
    // survive with NULL account columns and are still summed.
    expect(q!).not.toMatch(/LEFT JOIN gl_accounts/i);
    expect(q!).toMatch(/account_subtype/i);
  });

  it('consolidatedReportingService group cash ignores is_active', async () => {
    await getGroupDashboardStats(GROUP_A);

    const [q] = queriesMatching(/FROM bank_transactions bt/i);
    expect(q).toBeDefined();
    expect(q!).toMatch(/account_subtype = ANY\(\s*[?$]/i);
    expect(q!).not.toMatch(IS_ACTIVE_PREDICATE);
  });

  it('cashFlowForecastDataService opening cash ignores is_active', async () => {
    await getCurrentCashBalance(COMPANY_A);

    const [q] = queriesMatching(/total_cash/i);
    expect(q).toBeDefined();
    // The literal pair became CASH_SUBTYPES in round 6: the forecast's opening
    // cash and cash.balance.v1 must not disagree about which accounts are cash.
    expect(q!).toMatch(/account_subtype = ANY\(\s*[?$]/i);
    expect(q!).not.toMatch(IS_ACTIVE_PREDICATE);
  });

  it('openingBalanceEquityCheck reads the residual regardless of is_active', async () => {
    sqlMock.mockResolvedValue([{ accounts: 1, balance: '130000.00' }]);

    const result = await openingBalanceEquityCheck(COMPANY_A, { endDate: '2026-01-31' });

    const [q] = queriesMatching(/opening|is_system_account/i);
    expect(q).toBeDefined();
    expect(q!).toMatch(/is_system_account = true/i);
    expect(q!).not.toMatch(IS_ACTIVE_PREDICATE);
    // A residual on a deactivated clearing account must still be reported.
    expect(result.status).toBe('warn');
  });

  it('afs getUnmappedAccounts offers an inactive account that still carries posted activity', async () => {
    await getUnmappedAccounts(COMPANY_A);

    const [q] = queriesMatching(/afs_account_mappings/i);
    expect(q).toBeDefined();
    // Inactive accounts are not offered blindly — only those with posted GL
    // activity, which is exactly the set that would otherwise miss the AFS.
    expect(q!).toMatch(/gl_journal_lines/i);
    expect(q!).toMatch(/a\.is_active = true OR EXISTS/i);
  });

  it('afs getMappingStats counts inactive accounts with posted activity in the denominator', async () => {
    sqlMock.mockResolvedValue([{
      total_accounts: 5, mapped_accounts: 2, total_lines: 10, active_lines: 9, lines_with_mappings: 2,
    }]);

    const stats = await getMappingStats(COMPANY_A);

    const [q] = queriesMatching(/total_accounts/i);
    expect(q).toBeDefined();
    expect(q!).toMatch(/gl_journal_lines/i);
    expect(q!).toMatch(/a\.is_active = true OR EXISTS/i);
    expect(stats.unmappedAccounts).toBe(3);
  });
});
