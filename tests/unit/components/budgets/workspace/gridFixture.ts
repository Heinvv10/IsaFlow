/**
 * A small budget-grid read model for the workspace store / hook tests: two turnover lines, one
 * cost-of-sales line, an operating-expense header with two sub-accounts and a plain opex line,
 * one CC1-grain account, and an other-expense line. Amounts are rand, as on the wire.
 */
import type { GridAccount, GridCell, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';

export const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];

export const ID = {
  rev1: 'a0000000-0000-4000-8000-000000000001',
  rev2: 'a0000000-0000-4000-8000-000000000002',
  cos1: 'a0000000-0000-4000-8000-000000000003',
  hdr: 'a0000000-0000-4000-8000-000000000004',
  kid1: 'a0000000-0000-4000-8000-000000000005',
  kid2: 'a0000000-0000-4000-8000-000000000006',
  opex: 'a0000000-0000-4000-8000-000000000007',
  dimAcc: 'a0000000-0000-4000-8000-000000000008',
  oexp: 'a0000000-0000-4000-8000-000000000009',
  m1: 'c0000000-0000-4000-8000-000000000001',
  m2: 'c0000000-0000-4000-8000-000000000002',
  version: 'b0000000-0000-4000-8000-000000000001',
} as const;

function account(id: string, code: string, band: Band, extra: Partial<GridAccount> = {}): GridAccount {
  const revenue = band === 'turnover' || band === 'other_income';
  return {
    id, code, name: `Account ${code}`, type: revenue ? 'revenue' : 'expense', subtype: null, band, isActive: true,
    parentId: null, depth: 0, isHeader: false, childIds: [], ownAmounts: false, grain: null, rollup: null, ...extra,
  };
}

const cell = (glAccountId: string, month: string, amount: number, cc1Id: string | null = null): GridCell =>
  ({ glAccountId, cc1Id, cc2Id: null, buId: null, month, amount });

export const TOKEN = '2026-10-26T18:01:02.123456Z';

export function gridModel(overrides: Partial<GridReadModel> = {}): GridReadModel {
  const accounts: GridAccount[] = [
    account(ID.rev1, '1000', 'turnover', { grain: 'company' }),
    account(ID.rev2, '1010', 'turnover'),
    account(ID.cos1, '2000', 'cost_of_sales', { grain: 'company' }),
    account(ID.hdr, '3000', 'operating_expense', { isHeader: true, childIds: [ID.kid1, ID.kid2], rollup: MONTHS.map(() => 0) }),
    account(ID.kid1, '3010', 'operating_expense', { parentId: ID.hdr, depth: 1, grain: 'company' }),
    account(ID.kid2, '3020', 'operating_expense', { parentId: ID.hdr, depth: 1 }),
    account(ID.opex, '3100', 'operating_expense'),
    account(ID.dimAcc, '3200', 'operating_expense', { grain: 'cc1' }),
    account(ID.oexp, '4000', 'other_expense'),
  ];
  const cells: GridCell[] = [
    cell(ID.rev1, MONTHS[0]!, 1000), cell(ID.rev1, MONTHS[1]!, 0),
    cell(ID.cos1, MONTHS[0]!, 400),
    cell(ID.kid1, MONTHS[0]!, 50.5),
    cell(ID.dimAcc, MONTHS[0]!, 10, ID.m1), cell(ID.dimAcc, MONTHS[0]!, 20, ID.m2),
  ];
  const zero = MONTHS.map(() => 0);
  const metric = { turnover: zero, costOfSales: zero, grossProfit: zero, otherIncome: zero, operatingExpenses: zero, operatingProfit: zero, otherExpenses: zero, netProfit: zero };
  return {
    version: {
      id: ID.version, fiscalYear: 2027, name: 'Original', kind: 'original', status: 'draft', basedOnVersionId: null,
      isPrimary: true, approvedBy: null, approvedAt: null, lockedBy: null, lockedAt: null, unlockedBy: null,
      unlockedAt: null, unlockReason: null, createdBy: 'u1', createdAt: '2026-10-01T00:00:00.000000Z',
      updatedAt: TOKEN, amountCount: cells.length, total: 0,
    },
    updatedAt: TOKEN,
    year: { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', kind: 'normal', monthKeys: MONTHS },
    accounts,
    dimensions: {
      cc1: [{ id: ID.m1, code: 'CC-A', name: 'Alpha', isActive: true }, { id: ID.m2, code: 'CC-B', name: 'Beta', isActive: true }],
      cc2: [], bu: [],
    },
    cells,
    grains: { [ID.rev1]: 'company', [ID.cos1]: 'company', [ID.kid1]: 'company', [ID.dimAcc]: 'cc1' },
    totals: { months: metric, fy: { turnover: 0, costOfSales: 0, grossProfit: 0, otherIncome: 0, operatingExpenses: 0, operatingProfit: 0, otherExpenses: 0, netProfit: 0 } },
    ...overrides,
  };
}
