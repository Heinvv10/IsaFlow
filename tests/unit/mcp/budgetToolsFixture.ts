/**
 * A budget version's grid read model for the MCP budget tool unit tests: FY2027 (March 2026 - February
 * 2027), a revenue leaf, an expense leaf holding R100 in March, a header with a leaf below it, one CC1 member.
 */
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { bandTotals } from '@/modules/accounting/services/budgets/gridTotals';
import type { McpToolContext } from '@/lib/mcp/types';

export const COMPANY = '99999999-9999-4999-8999-999999999999';
export const VERSION = '10000000-0000-4000-8000-000000000001';
export const SALES = '20000000-0000-4000-8000-000000000001';
export const RENT = '20000000-0000-4000-8000-000000000002';
export const HEADER = '20000000-0000-4000-8000-000000000003';
export const CHILD = '20000000-0000-4000-8000-000000000004';
export const CC1 = '30000000-0000-4000-8000-000000000001';
export const TOKEN = '2026-11-16T10:00:00.000001Z';
export const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];

const account = (id: string, code: string, name: string, type: 'revenue' | 'expense', over: Record<string, unknown> = {}) => ({
  id, code, name, type, subtype: null, band: type === 'revenue' ? 'turnover' : 'operating_expense', isActive: true, parentId: null, depth: 0,
  isHeader: false, childIds: [], ownAmounts: false, grain: null, rollup: null, note: null, ...over,
});

export const version = (over: Record<string, unknown> = {}) => ({
  id: VERSION, fiscalYear: 2027, name: 'Budget', kind: 'scenario', status: 'draft', basedOnVersionId: null, isPrimary: false,
  approvedBy: null, approvedAt: null, lockedBy: null, lockedAt: null, unlockedBy: null, unlockedAt: null, unlockReason: null,
  createdBy: 'u-1', createdAt: TOKEN, updatedAt: TOKEN, amountCount: 1, total: 100, ...over,
});

export function model(over: Partial<GridReadModel> = {}): GridReadModel {
  const accounts = [
    account(SALES, '4000', 'Sales', 'revenue'), account(RENT, '6000', 'Rent', 'expense', { grain: 'company' }),
    account(HEADER, '7000', 'Admin', 'expense', { isHeader: true, childIds: [CHILD], rollup: Array(12).fill(0) }),
    account(CHILD, '7100', 'Stationery', 'expense', { parentId: HEADER, depth: 1 }),
  ] as GridReadModel['accounts'];
  return {
    version: version() as never, updatedAt: TOKEN,
    year: { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', kind: 'normal', monthKeys: MONTHS } as never,
    accounts, dimensions: { cc1: [{ id: CC1, code: 'C1', name: 'Centre', isActive: true }], cc2: [], bu: [] },
    cells: [{ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 100, source: 'typed' }],
    grains: { [RENT]: 'company' }, drivers: [], totals: bandTotals(accounts, new Map([[RENT, [10000, ...Array(11).fill(0)]]]), 12), holder: null,
    ...over,
  };
}

export const ctx = (role: string | null = 'owner', scopes: string[] = ['read:reports', 'write:budgets']): McpToolContext =>
  ({ companyId: COMPANY, userId: 'u-1', tokenJti: 'jti-1', oauthAppId: null, companyRole: role, scopes });

export const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
export const json = (r: { content: Array<{ text: string }> }) => JSON.parse(text(r)) as Record<string, unknown>;
