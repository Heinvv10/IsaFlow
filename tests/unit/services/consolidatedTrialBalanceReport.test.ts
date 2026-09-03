/**
 * GRP-06: the consolidated trial balance reports BALANCES, not the range's
 * movement. It used to filter `je.entry_date >= periodStart` for every account,
 * which is why it disagreed with the consolidated balance sheet — that reads
 * cumulatively. Balance-sheet group accounts are now cumulative to periodEnd,
 * income-statement ones cover the range, and each entity's pre-range profit is
 * folded into the group's retained-earnings account so the statement balances.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

const getGroupMembers = vi.fn();
const getCoaMappingsForCompanies = vi.fn();
const getPostedEliminations = vi.fn();
vi.mock('@/modules/accounting/services/reports/consolidatedTrialBalanceService', () => ({
  getGroupMembers: (...a: unknown[]) => getGroupMembers(...a),
  getCoaMappingsForCompanies: (...a: unknown[]) => getCoaMappingsForCompanies(...a),
  getPostedEliminations: (...a: unknown[]) => getPostedEliminations(...a),
}));

import { sql } from '@/lib/neon';
import { getConsolidatedTrialBalance } from '@/modules/accounting/services/reports/consolidatedTrialBalanceReport';

const GROUP_ID = 'eeeeeeee-0000-0000-0000-000000000001';
const CO_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const PERIOD_START = '2025-03-01';
const PERIOD_END = '2026-02-28';

const GROUP_BANK = 'gggggggg-0000-0000-0000-00000000000b';

type SqlMock = ReturnType<typeof vi.fn>;

/**
 * SQL text of the Nth `sql` tagged-template call, with SQL comments stripped.
 *
 * Asserting on raw template text is one edit away from a false pass: a
 * `-- no longer filtered by fiscal_period_id` comment satisfies a
 * `toContain('fiscal_period_id')` without the filter existing, and breaks a
 * `not.toContain` without the filter returning. Strip comments and the
 * assertion is about the query the database actually runs.
 */
function sqlTextOf(mockSql: SqlMock, callIndex: number): string {
  const strings = (mockSql.mock.calls[callIndex] as unknown[])[0] as string[];
  return strings
    .join(' ? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function mappings(entries: Array<[string, Record<string, string>]>) {
  return new Map([[CO_A, new Map(entries)]]);
}

const BANK_MAPPING = {
  groupAccountId: GROUP_BANK, groupAccountCode: 'B100', groupAccountName: 'Cash and equivalents',
  groupAccountType: 'asset', groupNormalBalance: 'debit', companyAccountId: 'acc-bank',
};

beforeEach(() => {
  vi.clearAllMocks();
  getGroupMembers.mockResolvedValue([
    { companyId: CO_A, companyName: 'Co A', ownershipPct: 100, consolidationMethod: 'full' },
  ]);
  getCoaMappingsForCompanies.mockResolvedValue(mappings([['acc-bank', BANK_MAPPING]]));
  getPostedEliminations.mockResolvedValue([]);
});

/** Queue the per-member queries: balances, then brought-forward profit. */
function primeMember(balanceRows: Record<string, unknown>[], broughtForward = '0') {
  const mockSql = sql as SqlMock;
  mockSql.mockResolvedValueOnce(balanceRows).mockResolvedValueOnce([{ retained: broughtForward }]);
  return mockSql;
}

describe('getConsolidatedTrialBalance (GRP-06 — balances, not range movement)', () => {
  it('bounds the entity query by periodEnd and cuts income statement accounts at periodStart', async () => {
    const mockSql = primeMember([{ account_id: 'acc-bank', total_debit: '1000', total_credit: '250' }]);
    await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);

    const params = (mockSql.mock.calls[0] as unknown[]).slice(1);
    expect(params).toContain(PERIOD_END);
    expect(params).toContain(PERIOD_START);

    const text = sqlTextOf(mockSql, 0);
    // Balance-sheet types must be exempt from the periodStart cut-off.
    expect(text).toContain("ga.account_type IN ('asset', 'liability', 'equity')");
    expect(text).toContain('je.entry_date <=');
  });

  it('reports one net balance per entity, not gross debit and credit turnover', async () => {
    primeMember([{ account_id: 'acc-bank', total_debit: '30640532.90', total_credit: '24637060.26' }]);
    const tb = await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);

    const row = tb.groupAccounts.find(a => a.groupAccountId === GROUP_BANK)!;
    expect(row.entities[CO_A]).toEqual({ debit: 6003472.64, credit: 0 });
    expect(row.consolidatedDebit).toBe(6003472.64);
    expect(row.consolidatedCredit).toBe(0);
  });

  it('puts a net credit balance in the credit column only', async () => {
    primeMember([{ account_id: 'acc-bank', total_debit: '100', total_credit: '613741.77' }]);
    const tb = await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);
    const row = tb.groupAccounts[0]!;
    expect(row.entities[CO_A]).toEqual({ debit: 0, credit: 613641.77 });
    expect(row.consolidatedCredit).toBe(613641.77);
    expect(row.consolidatedDebit).toBe(0);
  });

  it('drops an account whose balance nets to zero', async () => {
    primeMember([{ account_id: 'acc-bank', total_debit: '25000', total_credit: '25000' }]);
    const tb = await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);
    expect(tb.groupAccounts).toHaveLength(0);
  });

  it('reports an entity pre-range profit on a derived brought-forward row', async () => {
    primeMember([{ account_id: 'acc-bank', total_debit: '2254813.96', total_credit: '0' }], '2254813.96');

    const tb = await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);
    const re = tb.groupAccounts.find(a => a.groupAccountId === 'RE-BF')!;
    expect(re.accountType).toBe('equity');
    expect(re.derived).toBe(true);
    expect(re.accountName).toContain('derived');
    expect(re.accountName).toContain('not posted');
    expect(re.entities[CO_A]).toEqual({ debit: 0, credit: 2254813.96 });
    // ...and the whole statement balances.
    expect(tb.totals.consolidatedDebit).toBe(tb.totals.consolidatedCredit);
    expect(tb.totals.consolidatedDebit).toBe(2254813.96);
  });

  it('never marks a mapped entity account as derived', async () => {
    primeMember([{ account_id: 'acc-bank', total_debit: '1000', total_credit: '0' }], '500');
    const tb = await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);
    expect(tb.groupAccounts.find(a => a.groupAccountId === GROUP_BANK)!.derived).toBeUndefined();
  });

  it('asks for the brought-forward profit strictly before periodStart', async () => {
    const mockSql = primeMember([{ account_id: 'acc-bank', total_debit: '1', total_credit: '0' }], '5000');
    await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);
    const params = (mockSql.mock.calls[1] as unknown[]).slice(1);
    expect(params).toContain(PERIOD_START);
    expect(((mockSql.mock.calls[1] as unknown[])[0] as string[]).join('')).toContain('je.entry_date <');
  });

  it('reports the profit even when the group has no retained earnings mapping', async () => {
    // The derived row does not depend on group_coa_mappings, so an unmapped
    // group can no longer silently drop the figure and go out of balance.
    primeMember([{ account_id: 'acc-bank', total_debit: '5000', total_credit: '0' }], '5000');
    const tb = await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);
    expect(tb.groupAccounts.find(a => a.groupAccountId === 'RE-BF')!.entities[CO_A]!.credit).toBe(5000);
    expect(tb.totals.consolidatedDebit).toBe(tb.totals.consolidatedCredit);
  });
});

describe('getConsolidatedTrialBalance (eliminations follow the same basis)', () => {
  it('takes balance-sheet eliminations cumulatively and income-statement ones over the range', async () => {
    getPostedEliminations.mockImplementation(async (_g: string, start: string) =>
      start === '1900-01-01'
        ? [
            { groupAccountId: GROUP_BANK, groupAccountCode: 'B100', groupAccountName: 'Cash', groupAccountType: 'asset', debit: 0, credit: 500 },
            { groupAccountId: 'ie-1', groupAccountCode: 'E10', groupAccountName: 'Revenue', groupAccountType: 'revenue', debit: 9999, credit: 0 },
          ]
        : [
            { groupAccountId: GROUP_BANK, groupAccountCode: 'B100', groupAccountName: 'Cash', groupAccountType: 'asset', debit: 0, credit: 111 },
            { groupAccountId: 'ie-1', groupAccountCode: 'E10', groupAccountName: 'Revenue', groupAccountType: 'revenue', debit: 300, credit: 0 },
          ],
    );
    primeMember([{ account_id: 'acc-bank', total_debit: '1000', total_credit: '0' }]);

    const tb = await getConsolidatedTrialBalance(GROUP_ID, PERIOD_START, PERIOD_END);
    expect(getPostedEliminations).toHaveBeenCalledWith(GROUP_ID, '1900-01-01', PERIOD_END);
    expect(getPostedEliminations).toHaveBeenCalledWith(GROUP_ID, PERIOD_START, PERIOD_END);

    const bank = tb.groupAccounts.find(a => a.groupAccountId === GROUP_BANK)!;
    expect(bank.eliminationCredit).toBe(500);   // cumulative, not the 111 in-range figure
    const revenue = tb.groupAccounts.find(a => a.groupAccountId === 'ie-1')!;
    expect(revenue.eliminationDebit).toBe(300); // in-range, not the 9999 cumulative figure
  });
});
