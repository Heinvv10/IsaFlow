/**
 * The consolidated balance sheet signs a line by the SECTION it lands in.
 *
 * `getConsolidatedBalanceSheet` signed each member account by its own
 * `normal_balance` and each elimination by the group account's, and negated
 * nothing. So a contra-asset (Accumulated Depreciation, credit normal) was
 * ADDED to group assets, and a debit-normal liability or equity account
 * (Dividends Declared) was added to its side instead of reducing it — the
 * defect `balanceSheetService` carried, without even its contra-asset patch.
 *
 * Section rule, as `balanceSheetService`: assets debit less credit,
 * liabilities and equity credit less debit, for members and eliminations alike.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/reports/consolidatedTrialBalanceService', () => ({
  getGroupMembers: vi.fn(),
  getCoaMappingsForCompanies: vi.fn(),
  getPostedEliminations: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  getGroupMembers,
  getCoaMappingsForCompanies,
  getPostedEliminations,
} from '@/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { getConsolidatedBalanceSheet } from '@/modules/accounting/services/reports/consolidatedStatementsService';
import type { ConsolidatedBSLineItem } from '@/modules/accounting/services/reports/consolidatedTrialBalanceService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const GROUP = 'group-1';
const MEMBER = 'company-1';

/** [company account id, group code, group type] — one group account per member account. */
const ACCOUNTS: Array<[string, string, string]> = [
  ['acc-1000', '1000', 'asset'],
  ['acc-1230', '1230', 'asset'],
  ['acc-2100', '2100', 'liability'],
  ['acc-2900', '2900', 'liability'],
  ['acc-3000', '3000', 'equity'],
  ['acc-3400', '3400', 'equity'],
];

/** The member's trial balance: balances with retained earnings of 1 000. */
const MEMBER_ROWS = [
  { account_id: 'acc-1000', account_type: 'asset', normal_balance: 'debit', total_debit: 10000, total_credit: 0 },
  { account_id: 'acc-1230', account_type: 'asset', normal_balance: 'credit', total_debit: 0, total_credit: 2000 },
  { account_id: 'acc-2100', account_type: 'liability', normal_balance: 'credit', total_debit: 0, total_credit: 5000 },
  { account_id: 'acc-2900', account_type: 'liability', normal_balance: 'debit', total_debit: 500, total_credit: 0 },
  { account_id: 'acc-3000', account_type: 'equity', normal_balance: 'credit', total_debit: 0, total_credit: 4000 },
  { account_id: 'acc-3400', account_type: 'equity', normal_balance: 'debit', total_debit: 1500, total_credit: 0 },
];

function line(lines: ConsolidatedBSLineItem[], code: string): ConsolidatedBSLineItem {
  const found = lines.find((l) => l.accountCode === code);
  expect(found, `line ${code}`).toBeDefined();
  return found!;
}

describe('consolidated balance sheet — contra accounts reduce their own section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getGroupMembers as unknown as MockedFunction<() => Promise<unknown>>).mockResolvedValue([
      { companyId: MEMBER, companyName: 'Member', ownershipPct: 100, consolidationMethod: 'full' },
    ]);
    (getCoaMappingsForCompanies as unknown as MockedFunction<() => Promise<unknown>>).mockResolvedValue(
      new Map([[MEMBER, new Map(ACCOUNTS.map(([id, code, type]) => [id, {
        groupAccountId: `ga-${code}`, groupAccountCode: code, groupAccountName: `Group ${code}`,
        groupAccountType: type, companyAccountId: id,
      }]))]]),
    );
    // A balanced elimination: Dr Accumulated Depreciation 100 / Cr Dividends Declared 100.
    (getPostedEliminations as unknown as MockedFunction<() => Promise<unknown>>).mockResolvedValue([
      { groupAccountId: 'ga-1230', groupAccountCode: '1230', groupAccountName: 'Group 1230', groupAccountType: 'asset', debit: 100, credit: 0 },
      { groupAccountId: 'ga-3400', groupAccountCode: '3400', groupAccountName: 'Group 3400', groupAccountType: 'equity', debit: 0, credit: 100 },
    ]);
    mockSql
      .mockResolvedValueOnce(MEMBER_ROWS)
      .mockResolvedValueOnce([{ revenue: 3000, expenses: 2000 }])
      .mockResolvedValueOnce([{ group_account_id: 'ga-3100', account_code: '3100', account_name: 'Retained Earnings' }]);
  });

  it('prints a contra-asset as a negative asset line, and eliminates on the asset side', async () => {
    const bs = await getConsolidatedBalanceSheet(GROUP, '2026-08-31');
    const accDep = line(bs.assets, '1230');
    expect(accDep.entities[MEMBER]).toBeCloseTo(-2000, 2);
    expect(accDep.eliminationAmount).toBeCloseTo(100, 2);
    expect(accDep.consolidatedAmount).toBeCloseTo(-1900, 2);
    expect(bs.totalAssets.consolidatedAmount).toBeCloseTo(8100, 2);
  });

  it('prints a debit-normal liability as a negative liability line', async () => {
    const bs = await getConsolidatedBalanceSheet(GROUP, '2026-08-31');
    expect(line(bs.liabilities, '2900').consolidatedAmount).toBeCloseTo(-500, 2);
    expect(bs.totalLiabilities.consolidatedAmount).toBeCloseTo(4500, 2);
  });

  it('prints a debit-normal equity account as a negative equity line', async () => {
    const bs = await getConsolidatedBalanceSheet(GROUP, '2026-08-31');
    const dividends = line(bs.equity, '3400');
    expect(dividends.entities[MEMBER]).toBeCloseTo(-1500, 2);
    expect(dividends.eliminationAmount).toBeCloseTo(100, 2);
    expect(dividends.consolidatedAmount).toBeCloseTo(-1400, 2);
    expect(bs.totalEquity.consolidatedAmount).toBeCloseTo(3600, 2);
  });

  it('balances: group assets equal group liabilities plus equity', async () => {
    const bs = await getConsolidatedBalanceSheet(GROUP, '2026-08-31');
    expect(bs.totalAssets.consolidatedAmount).toBeCloseTo(
      bs.totalLiabilities.consolidatedAmount + bs.totalEquity.consolidatedAmount, 2,
    );
    expect(bs.totalAssets.entities[MEMBER]).toBeCloseTo(
      bs.totalLiabilities.entities[MEMBER]! + bs.totalEquity.entities[MEMBER]!, 2,
    );
  });
});
