/**
 * A contra account REDUCES the section it sits in — whichever side that is.
 *
 * `fetchBalanceSheetData` signed each account by its `normal_balance` and then
 * negated only contra-ASSETS (asset type, credit normal: Accumulated
 * Depreciation). A debit-normal EQUITY account (Dividends Declared, Drawings)
 * or a debit-normal LIABILITY was therefore added to its section at
 * +|balance| instead of reducing it. On isaflow_dev, Sample Trading's R2.53m of
 * dividends declared overstated equity by twice that, and the report logged
 * "Balance sheet equation violated".
 *
 * The rule a section total needs is the ACCOUNT TYPE's, not the account's:
 * assets debit less credit, liabilities and equity credit less debit — the
 * same rule `getEquityBases` and the board pack's figures use.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockGetSystemAccount = getSystemAccount as unknown as MockedFunction<
  (subtype: string, companyId: string) => Promise<{ accountCode: string }>
>;

const COMPANY_ID = 'e6f0dde9-1688-4562-9ddc-be0477c5999b';
const AS_AT = '2026-08-31';

/**
 * A trial balance that balances: debits 10 000 + 1 500 + 500 + expenses 2 000
 * = credits 2 000 + 5 000 + 4 000 + revenue 3 000 = 14 000. The service selects
 * no `normal_balance`; the three contra rows carry one ONLY to prove it is
 * ignored if present — signed by it, each would add to its section.
 */
const GL_ROWS = [
  { account_code: '1000', account_name: 'Bank', account_type: 'asset', total_debit: 10000, total_credit: 0 },
  { account_code: '1230', account_name: 'Accumulated Depreciation', account_type: 'asset', normal_balance: 'credit', total_debit: 0, total_credit: 2000 },
  { account_code: '2100', account_name: 'Loan', account_type: 'liability', total_debit: 0, total_credit: 5000 },
  { account_code: '2900', account_name: 'Loan Discount', account_type: 'liability', normal_balance: 'debit', total_debit: 500, total_credit: 0 },
  { account_code: '3000', account_name: 'Share Capital', account_type: 'equity', total_debit: 0, total_credit: 4000 },
  { account_code: '3400', account_name: 'Dividends Declared', account_type: 'equity', normal_balance: 'debit', total_debit: 1500, total_credit: 0 },
];
const RE_ROW = [{ revenue: 3000, expenses: 2000 }];

function line(lines: Array<{ accountCode: string; balance: number }>, code: string): number {
  const found = lines.find((l) => l.accountCode === code);
  expect(found, `line ${code}`).toBeDefined();
  return found!.balance;
}

describe('balance sheet — contra accounts reduce their own section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValueOnce(GL_ROWS).mockResolvedValueOnce(RE_ROW);
    mockGetSystemAccount.mockResolvedValue({ accountCode: '3100' });
  });

  it('prints a debit-normal equity account as a negative equity line', async () => {
    const bs = await getBalanceSheet(COMPANY_ID, AS_AT);
    expect(line(bs.equity, '3400')).toBeCloseTo(-1500, 2);
    expect(line(bs.equity, '3000')).toBeCloseTo(4000, 2);
    expect(line(bs.equity, '3100')).toBeCloseTo(1000, 2);
    expect(bs.totalEquity).toBeCloseTo(3500, 2);
  });

  it('prints a debit-normal liability as a negative liability line', async () => {
    const bs = await getBalanceSheet(COMPANY_ID, AS_AT);
    expect(line(bs.liabilities, '2900')).toBeCloseTo(-500, 2);
    expect(bs.totalLiabilities).toBeCloseTo(4500, 2);
  });

  it('still prints a contra-asset as a negative asset line', async () => {
    const bs = await getBalanceSheet(COMPANY_ID, AS_AT);
    expect(line(bs.assets, '1230')).toBeCloseTo(-2000, 2);
    expect(bs.totalAssets).toBeCloseTo(8000, 2);
  });

  it('balances, and does not log a violated equation', async () => {
    const bs = await getBalanceSheet(COMPANY_ID, AS_AT);
    expect(bs.totalAssets).toBeCloseTo(bs.totalLiabilities + bs.totalEquity, 2);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
