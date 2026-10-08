/**
 * The consolidated balance sheet signed each member balance by the MEMBER account's normal side and each elimination
 * by the GROUP account's, so a contra account (Dividends Declared / Drawings: debit-normal equity; accumulated
 * depreciation: credit-normal asset) was added to its section instead of subtracted, and the group sheet stopped
 * balancing. Same defect as the single-company balance sheet (balanceSheetContraAccounts.test.ts).
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/consolidatedTrialBalanceService', () => ({
  getGroupMembers: vi.fn(), getCoaMappingsForCompanies: vi.fn(), getPostedEliminations: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  getGroupMembers, getCoaMappingsForCompanies, getPostedEliminations, type MappingEntry,
} from '@/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { getConsolidatedBalanceSheet } from '@/modules/accounting/services/reports/consolidatedStatementsService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown>>;
const CO = '00000000-0000-0000-0000-0000000000c1';

const map = (companyAccountId: string, code: string, type: string): [string, MappingEntry] => [companyAccountId, {
  groupAccountId: `g${code}`, groupAccountCode: code, groupAccountName: code, groupAccountType: type, companyAccountId,
}];
const row = (account_id: string, account_type: string, total_debit: number, total_credit: number) =>
  ({ account_id, account_type, total_debit, total_credit });

describe('consolidated balance sheet: contra accounts subtract from their section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGroupMembers).mockResolvedValue([{ companyId: CO, companyName: 'Co', ownershipPct: 100, consolidationMethod: 'full' }]);
    vi.mocked(getCoaMappingsForCompanies).mockResolvedValue(new Map([[CO, new Map([
      map('bank', '1000', 'asset'),
      map('ppe', '1500', 'asset'),
      map('accdep', '1510', 'asset'),
      map('cap', '3000', 'equity'),
      map('div', '3400', 'equity'),
    ])]]));
  });

  it('dividends and accumulated depreciation reduce their sections; an elimination on dividends is signed by section', async () => {
    // Bank 30,000 + PPE 100,000 - AccDep 40,000 = 90,000 = Capital 100,000 - Dividends 10,000 (no profit)
    mockSql.mockResolvedValueOnce([
      row('bank', 'asset', 30000, 0),
      row('ppe', 'asset', 100000, 0),
      row('accdep', 'asset', 0, 40000),
      row('cap', 'equity', 0, 100000),
      row('div', 'equity', 10000, 0),
    ]).mockResolvedValueOnce([{ revenue: 0, expenses: 0 }]);
    // Eliminating R2,000 of intra-group dividend credits the dividends account (it shrinks toward zero).
    vi.mocked(getPostedEliminations).mockResolvedValue([
      { groupAccountId: 'g3400', groupAccountCode: '3400', groupAccountName: '3400', groupAccountType: 'equity', debit: 0, credit: 2000 },
    ] as Awaited<ReturnType<typeof getPostedEliminations>>);

    const bs = await getConsolidatedBalanceSheet('grp', '2026-12-31');

    expect(bs.totalAssets.entities[CO]).toBeCloseTo(90000, 2);
    expect(bs.equity.find((e) => e.accountCode === '3400')!.entities[CO]).toBeCloseTo(-10000, 2);
    expect(bs.equity.find((e) => e.accountCode === '3400')!.eliminationAmount).toBeCloseTo(2000, 2);
    expect(bs.totalEquity.entities[CO]).toBeCloseTo(90000, 2);
    expect(bs.totalAssets.entities[CO]).toBeCloseTo((bs.totalLiabilities.entities[CO] ?? 0) + bs.totalEquity.entities[CO]!, 2);
  });
  it("a member line is signed by the GROUP line's section, and an elimination on accumulated depreciation by the asset section", async () => {
    vi.mocked(getCoaMappingsForCompanies).mockResolvedValue(new Map([[CO, new Map([
      map('bank', '1000', 'asset'),
      map('accdep', '1510', 'asset'),
      map('ppe', '1500', 'asset'),
      // A member ASSET (a clearing account) mapped onto a group LIABILITY line: its debit balance must REDUCE liabilities.
      ['clearing', { groupAccountId: 'g2100', groupAccountCode: '2100', groupAccountName: '2100', groupAccountType: 'liability', companyAccountId: 'clearing' }],
      map('cap', '3000', 'equity'),
    ])]]));
    // Bank 5,000 + PPE 2,000 - AccDep 1,000 = 6,000 = (Clearing -1,000) + Capital 7,000
    mockSql.mockResolvedValueOnce([
      row('bank', 'asset', 5000, 0),
      row('ppe', 'asset', 2000, 0),
      row('accdep', 'asset', 0, 1000),
      row('clearing', 'asset', 1000, 0),
      row('cap', 'equity', 0, 7000),
    ]).mockResolvedValueOnce([{ revenue: 0, expenses: 0 }]);
    // An elimination DEBITING accumulated depreciation by 500 shrinks it: +500 on the asset section.
    vi.mocked(getPostedEliminations).mockResolvedValue([
      { groupAccountId: 'g1510', groupAccountCode: '1510', groupAccountName: '1510', groupAccountType: 'asset', debit: 500, credit: 0 },
    ] as Awaited<ReturnType<typeof getPostedEliminations>>);

    const bs = await getConsolidatedBalanceSheet('grp', '2026-12-31');

    expect(bs.liabilities.find((l) => l.accountCode === '2100')!.entities[CO]).toBeCloseTo(-1000, 2);
    expect(bs.totalLiabilities.entities[CO]).toBeCloseTo(-1000, 2);
    expect(bs.assets.find((a) => a.accountCode === '1510')!.eliminationAmount).toBeCloseTo(500, 2);
    expect(bs.totalAssets.entities[CO]).toBeCloseTo((bs.totalLiabilities.entities[CO] ?? 0) + bs.totalEquity.entities[CO]!, 2);
  });
});
