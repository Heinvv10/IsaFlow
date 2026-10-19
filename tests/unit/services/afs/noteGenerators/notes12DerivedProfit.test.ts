// Note 12 (share capital and reserves) adds the profit to year end, as the balance sheet does (G-01).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockUnsafe } from '../../../helpers/sqlFragmentMock';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: mockUnsafe }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/afs/afsFiscalPeriod', () => ({
  getFiscalRange: vi.fn(async () => ({ start: '2026-01-01', end: '2026-12-31' })),
}));
vi.mock('@/modules/accounting/services/afs/entityTerminology', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/afs/entityTerminology')>();
  return { ...actual, getCompanyTerminology: vi.fn().mockResolvedValue(actual.getTerminology('pty')) };
});
const derivedProfit = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ calculateRetainedEarnings: derivedProfit }));

import { sql } from '@/lib/neon';
import { generateNote12ShareCapital } from '@/modules/accounting/services/afs/noteGenerators/notes11to15';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const COMPANY_ID = 'ccc-test-0000-0000-0000-000000000012';

describe('generateNote12ShareCapital derived profit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds the derived profit to the retained-earnings row', async () => {
    derivedProfit.mockResolvedValueOnce(250);
    sqlMock.mockResolvedValueOnce([
      { account_name: 'Retained Earnings', account_code: '3200', account_subtype: 'retained_earnings', balance: 100 },
    ]);
    const result = await generateNote12ShareCapital(COMPANY_ID, 2026);
    expect((result.dataSnapshot.shareCapital as Array<{ balance: unknown }>).map((r) => Number(r.balance))).toEqual([350]);
  });

  it('shows the derived profit as its own row when no retained-earnings account carries a balance', async () => {
    derivedProfit.mockResolvedValueOnce(250);
    sqlMock.mockResolvedValueOnce([
      { account_name: 'Ordinary Share Capital', account_code: '3001', account_subtype: 'share_capital', balance: 1000 },
    ]);
    const rows = (await generateNote12ShareCapital(COMPANY_ID, 2026)).dataSnapshot.shareCapital as Array<Record<string, unknown>>;
    expect(rows.map((r) => Number(r.balance))).toEqual([1000, 250]);
    expect(String(rows[1]!.account_name)).toMatch(/derived/);
  });

  it('adds no row for a nil profit', async () => {
    sqlMock.mockResolvedValueOnce([
      { account_name: 'Ordinary Share Capital', account_code: '3001', account_subtype: 'share_capital', balance: 1000 },
    ]);
    const rows = (await generateNote12ShareCapital(COMPANY_ID, 2026)).dataSnapshot.shareCapital as unknown[];
    expect(rows).toHaveLength(1);
  });
});
