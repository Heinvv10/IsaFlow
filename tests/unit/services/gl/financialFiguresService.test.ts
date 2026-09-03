/**
 * Unit tests for getFinancialFigures / toFinancialData.
 *
 * Guards the query contract the reporting audit fixed: posted-only, tenant
 * scoped on BOTH journal tables, grouped by account_type + account_subtype, and
 * with no `account_code` anywhere in the SQL. The period/cumulative split is
 * what lets one query serve both the P&L and the balance sheet.
 *
 * DB is mocked — no live connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});

import { sql } from '@/lib/neon';
import {
  getFinancialFigures,
  toFinancialData,
  unclassifiedWarning,
  inventoryWarning,
} from '@/modules/accounting/services/gl/financialFiguresService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

/**
 * The SQL text the tagged template produced, joined across interpolations and
 * with SQL comments stripped.
 *
 * The stripping is load-bearing. Without it, moving a real clause into a `--`
 * comment while leaving the words in place keeps every `toMatch` assertion
 * green — the test would be asserting on prose, not on the query that runs.
 * Verified by mutation: commenting out the GROUP BY passes against the raw
 * text and fails against this.
 */
function lastQueryText(): string {
  const strings = mockSql.mock.calls[0]![0] as unknown as string[];
  return strings
    .join(' ? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

describe('lastQueryText', () => {
  it('strips SQL comments so assertions cannot match commented-out clauses', () => {
    mockSql.mockResolvedValue([]);
    // Guard the guard: prove the helper removes both comment forms.
    const stripped = ['a -- GROUP BY x\nb', '/* GROUP BY y */ c']
      .map((t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' '))
      .join(' ');
    expect(stripped).not.toMatch(/GROUP BY/);
  });
});

beforeEach(() => {
  mockSql.mockReset();
});

describe('getFinancialFigures', () => {
  it('never classifies on account_code, and groups on type + subtype', async () => {
    mockSql.mockResolvedValue([]);
    await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31');
    const text = lastQueryText();
    expect(text).not.toMatch(/account_code/);
    expect(text).toMatch(/GROUP BY ga\.account_type, ga\.account_subtype/);
  });

  it('reads posted entries only and scopes both journal tables by company', async () => {
    mockSql.mockResolvedValue([]);
    await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31');
    const text = lastQueryText();
    expect(text).toMatch(/je\.status = 'posted'/);
    expect(text).toMatch(/je\.company_id/);
    expect(text).toMatch(/jl\.company_id/);
    const params = mockSql.mock.calls[0]!.slice(1);
    expect(params).toEqual(['2026-01-01', '2026-01-01', COMPANY, COMPANY, '2026-12-31']);
  });

  it('splits period movement from cumulative balances off one query', async () => {
    mockSql.mockResolvedValue([
      {
        account_type: 'revenue', account_subtype: 'sales', account_count: '3',
        period_debit: '0', period_credit: '100000',
        cumulative_debit: '0', cumulative_credit: '450000',
      },
      {
        account_type: 'asset', account_subtype: 'bank', account_count: '85',
        period_debit: '20000', period_credit: '5000',
        cumulative_debit: '90000', cumulative_credit: '10000',
      },
    ]);

    const { period, cumulative } = await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31');
    expect(period.revenue).toBe(100_000);
    expect(cumulative.revenue).toBe(450_000);
    expect(period.cash).toBe(15_000);
    expect(cumulative.cash).toBe(80_000);
    expect(cumulative.totalAssets).toBe(80_000);
  });
});

describe('toFinancialData', () => {
  it('takes P&L from the period and the balance sheet from cumulative', async () => {
    mockSql.mockResolvedValue([
      {
        account_type: 'revenue', account_subtype: 'sales', account_count: '1',
        period_debit: '0', period_credit: '100000',
        cumulative_debit: '0', cumulative_credit: '400000',
      },
      {
        account_type: 'expense', account_subtype: 'cost_of_sales', account_count: '1',
        period_debit: '40000', period_credit: '0',
        cumulative_debit: '150000', cumulative_credit: '0',
      },
      {
        account_type: 'asset', account_subtype: 'fixed_assets', account_count: '1',
        period_debit: '0', period_credit: '0',
        cumulative_debit: '250000', cumulative_credit: '0',
      },
      {
        account_type: 'equity', account_subtype: 'equity', account_count: '1',
        period_debit: '0', period_credit: '0',
        cumulative_debit: '0', cumulative_credit: '90000',
      },
    ]);

    const data = toFinancialData(await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31'));
    expect(data.revenue).toBe(100_000);
    expect(data.costOfSales).toBe(40_000);
    expect(data.netProfit).toBe(60_000);
    expect(data.totalAssets).toBe(250_000);
    // Non-current: a fixed_assets account must not inflate current assets.
    expect(data.currentAssets).toBe(0);
    // Current-year profit is not closed into retained earnings yet.
    expect(data.totalEquity).toBe(150_000);
  });
});

describe('unclassifiedWarning', () => {
  it('is null when every account carries a recognised subtype', async () => {
    mockSql.mockResolvedValue([
      {
        account_type: 'asset', account_subtype: 'bank', account_count: '2',
        period_debit: '10', period_credit: '0',
        cumulative_debit: '10', cumulative_credit: '0',
      },
    ]);
    const { cumulative } = await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31');
    expect(unclassifiedWarning(cumulative)).toBeNull();
  });

  it('reports the account count and amount that were defaulted to current', async () => {
    mockSql.mockResolvedValue([
      {
        account_type: 'asset', account_subtype: null, account_count: '102',
        period_debit: '0', period_credit: '0',
        cumulative_debit: '5000', cumulative_credit: '0',
      },
    ]);
    const { cumulative } = await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31');
    const warning = unclassifiedWarning(cumulative);
    expect(warning).not.toBeNull();
    expect(warning!.accounts).toBe(102);
    expect(warning!.amount).toBe(5_000);
  });
});

describe('inventory resolvability', () => {
  /**
   * No production account carries an inventory subtype. The three
   * inventory-named accounts are classified `current_assets` (2) and NULL (1),
   * and every candidate linkage that could identify an inventory control
   * account is empty: products.gl_inventory_account_id 0/6 populated,
   * product_categories.gl_inventory_account_id 0/8, items/stock_items/
   * stock_levels 0 rows, and SystemAccountKey has no inventory role.
   *
   * So inventory resolves to 0.00 for every company — which today is the right
   * answer, and the moment one of those accounts takes a balance becomes the
   * wrong one, silently, because the quick ratio will keep equalling the
   * current ratio and look exactly as it does now. The resolver must therefore
   * report whether it could identify inventory AT ALL, separately from the
   * amount.
   */
  it('reports inventory as unresolved when no account is classified as inventory', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          account_type: 'asset', account_subtype: 'current_assets', account_count: '1',
          period_debit: '0', period_credit: '0',
          cumulative_debit: '50000', cumulative_credit: '0',
        },
      ])
      .mockResolvedValueOnce([{ has_inventory: false }]);

    const figures = await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31');
    expect(figures.inventoryClassified).toBe(false);
    // The amount is still zero — but zero-because-unknown, not zero-because-none.
    expect(figures.cumulative.inventory).toBe(0);

    const warning = inventoryWarning(figures);
    expect(warning).not.toBeNull();
    expect(warning!.message).toMatch(/quick ratio/i);
  });

  it('reports inventory as resolved when an account carries the subtype', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          account_type: 'asset', account_subtype: 'inventory', account_count: '1',
          period_debit: '0', period_credit: '0',
          cumulative_debit: '80000', cumulative_credit: '0',
        },
      ])
      .mockResolvedValueOnce([{ has_inventory: true }]);

    const figures = await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31');
    expect(figures.inventoryClassified).toBe(true);
    expect(figures.cumulative.inventory).toBe(80_000);
    expect(inventoryWarning(figures)).toBeNull();
  });

  it('probes the chart of accounts, not just accounts with movement', async () => {
    // An inventory account that has never been posted to still counts as
    // classified — otherwise a company with a correctly set-up but unused
    // inventory account would be warned at forever.
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ has_inventory: true }]);

    const figures = await getFinancialFigures(COMPANY, '2026-01-01', '2026-12-31');
    expect(figures.inventoryClassified).toBe(true);
    expect(inventoryWarning(figures)).toBeNull();

    const probe = mockSql.mock.calls[1]!;
    const text = (probe[0] as unknown as string[])
      .join(' ? ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ');
    expect(text).toMatch(/FROM gl_accounts/);
    expect(text).not.toMatch(/gl_journal_lines/);
    const params = probe.slice(1).filter(Array.isArray).flat();
    expect(params).toContain('inventory');
  });
});
