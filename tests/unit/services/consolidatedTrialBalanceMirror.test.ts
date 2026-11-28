/**
 * The consolidated trial balance's mirrored (derived) eliminations: the window of the income-statement ones (the members' fiscal year start;
 * a note when the members' years start on different dates), and what the derivation could not apply (carried to the page).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../helpers/fiscalYearSqlFake')).registryMock());

const getGroupMembers = vi.fn();
const getCoaMappingsForCompanies = vi.fn();
const getPostedEliminationsSplit = vi.fn();
vi.mock('@/modules/accounting/services/reports/consolidatedTrialBalanceService', () => ({
  getGroupMembers: (...a: unknown[]) => getGroupMembers(...a),
  getCoaMappingsForCompanies: (...a: unknown[]) => getCoaMappingsForCompanies(...a),
  getPostedEliminationsSplit: (...a: unknown[]) => getPostedEliminationsSplit(...a),
}));

import { sql } from '@/lib/neon';
import { getConsolidatedTrialBalance } from '@/modules/accounting/services/reports/consolidatedTrialBalanceReport';
import { fakeRegistry, resetFakeRegistry } from '../../helpers/fiscalYearSqlFake';

const GROUP_ID = 'eeeeeeee-0000-0000-0000-000000000001';
const CO_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const CO_B = 'aaaaaaaa-0000-0000-0000-000000000002';
const BANK = { groupAccountId: 'gggggggg-0000-0000-0000-00000000000b', groupAccountCode: 'B100', groupAccountName: 'Cash', groupAccountType: 'asset', companyAccountId: 'acc-bank' };
type SqlMock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeRegistry();
  getGroupMembers.mockResolvedValue([{ companyId: CO_A, companyName: 'Co A', ownershipPct: 100, consolidationMethod: 'full' }]);
  getCoaMappingsForCompanies.mockResolvedValue(new Map([[CO_A, new Map([['acc-bank', BANK]])]]));
  getPostedEliminationsSplit.mockResolvedValue({ cumulative: [], inRange: [] });
});

/** The per-member queries, in order: 0 balances, 1 brought-forward profit. */
function primeMember(balanceRows: Record<string, unknown>[]) {
  (sql as SqlMock).mockResolvedValueOnce(balanceRows).mockResolvedValueOnce([{ retained: '0' }]);
}

describe('the mirrored eliminations of the consolidated trial balance', () => {
  it('B-M3: a mid-year range takes the income-statement eliminations from the members\' fiscal year start (the window of their P&L columns), not periodStart', async () => {
    primeMember([{ account_id: 'acc-bank', total_debit: '1000', total_credit: '0' }]);
    const tb = await getConsolidatedTrialBalance(GROUP_ID, '2025-06-01', '2025-06-30');
    expect(tb.fiscalYearStarts[CO_A]).toBe('2025-03-01');
    expect(getPostedEliminationsSplit).toHaveBeenCalledWith(GROUP_ID, '2025-03-01', '2025-06-30', '1900-01-01', []);
    expect(tb.eliminationsNote).toBeNull();   // (members sharing a year start: one window, nothing to say)
  });

  it('R13 quality M2: the mirrored eliminations the derivation could not apply (unmapped account) are returned for the page', async () => {
    primeMember([{ account_id: 'acc-bank', total_debit: '1000', total_credit: '0' }]);
    const gone = { transactionId: 't9', keyDate: '2025-06-10', description: 'Automatic: mirrored intercompany documents - Invoice 9', amount: 750 };
    getPostedEliminationsSplit.mockImplementation(async (...a: unknown[]) => { (a[4] as unknown[]).push(gone); return { cumulative: [], inRange: [] }; });
    const tb = await getConsolidatedTrialBalance(GROUP_ID, '2025-06-01', '2025-06-30');
    expect(tb.droppedMirrored).toEqual([gone]);
  });

  it('R21 L7: members whose years start on different dates: the window is the EARLIEST start and the response says so (a note, with both dates)', async () => {
    getGroupMembers.mockResolvedValue([
      { companyId: CO_A, companyName: 'Co A', ownershipPct: 100, consolidationMethod: 'full' },
      { companyId: CO_B, companyName: 'Co B', ownershipPct: 100, consolidationMethod: 'full' },
    ]);
    getCoaMappingsForCompanies.mockResolvedValue(new Map([[CO_A, new Map([['acc-bank', BANK]])], [CO_B, new Map([['acc-bank', BANK]])]]));
    fakeRegistry.companies[CO_B] = { years: [], templateMonth: 12 };   // Co A: March year end; Co B: December
    primeMember([{ account_id: 'acc-bank', total_debit: '100', total_credit: '0' }]);
    primeMember([{ account_id: 'acc-bank', total_debit: '100', total_credit: '0' }]);
    const tb = await getConsolidatedTrialBalance(GROUP_ID, '2026-02-01', '2026-02-28');
    expect(tb.coterminous).toBe(false);
    expect(getPostedEliminationsSplit).toHaveBeenCalledWith(GROUP_ID, '2025-03-01', '2026-02-28', '1900-01-01', []);
    expect(tb.eliminationsNote).toContain('from 2025-03-01 (the earliest year start) to 2026-02-28');
    expect(tb.eliminationsNote).toContain('no matching amount in its column');
  });
});
