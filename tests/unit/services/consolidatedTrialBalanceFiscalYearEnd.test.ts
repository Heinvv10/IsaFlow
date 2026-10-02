/**
 * D4: the consolidated trial balance cuts each member's income statement (and
 * its brought-forward profit) at the fiscal year containing the range END —
 * the same basis as the single-company trial balance and the ledger listings.
 * A Jan–Dec range on a March company used to carry March–December of the
 * PREVIOUS year in the P&L rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/consolidatedTrialBalanceService', () => ({
  getGroupMembers: vi.fn(async () => [
    { companyId: 'aaaaaaaa-0000-0000-0000-000000000001', companyName: 'Co A', ownershipPct: 100, consolidationMethod: 'full' },
  ]),
  getCoaMappingsForCompanies: vi.fn(async () => new Map([['aaaaaaaa-0000-0000-0000-000000000001', new Map([['acc-bank', {
    groupAccountId: 'g-bank', groupAccountCode: 'B100', groupAccountName: 'Cash', groupAccountType: 'asset',
    groupNormalBalance: 'debit', companyAccountId: 'acc-bank',
  }]])]])),
  getPostedEliminations: vi.fn(async () => []),
}));

import { sql } from '@/lib/neon';
import { getConsolidatedTrialBalance } from '@/modules/accounting/services/reports/consolidatedTrialBalanceReport';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const params = (call: number) => (mockSql.mock.calls[call] as unknown[]).slice(1);

beforeEach(() => { mockSql.mockReset(); });

describe('consolidated trial balance across a fiscal-year start', () => {
  it('cuts the P&L and the brought-forward profit at the FY of the range end', async () => {
    mockSql
      .mockResolvedValueOnce([{ financial_year_start: 3 }])
      .mockResolvedValueOnce([{ account_id: 'acc-bank', total_debit: '100', total_credit: '0' }])
      .mockResolvedValueOnce([{ retained: '0' }]);

    const tb = await getConsolidatedTrialBalance('group', '2026-01-01', '2026-12-31');

    expect(tb.fiscalYearStarts['aaaaaaaa-0000-0000-0000-000000000001']).toBe('2026-03-01');
    expect(params(1)).toContain('2026-03-01');
    expect(params(1)).not.toContain('2025-03-01');
    expect(params(2)).toContain('2026-03-01');
  });
});
