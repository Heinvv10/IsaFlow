/**
 * `cash.balance.v1` — the owning implementation.
 *
 * Cash had four answers before this. Two of them (`bankAccountStatusService`,
 * `kpiDashboardService`) sum `bank_transactions.amount`, which is the STATEMENT
 * balance and a different question from the ledger's; both also filter
 * `is_active = true`, which is a picker flag and says nothing about whether an
 * account holds money. `cashFlowDirectService` had the right basis but kept it
 * private to one file, so nothing else could reach it.
 *
 * This service is the GL basis, and the tests below are mostly about what it
 * must NOT do: no `is_active`, no `now()`, no unposted journals, and no
 * unscoped query.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sql } from '@/lib/neon';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function sqlText(i = 0): string {
  const parts = mockSql.mock.calls[i]?.[0] as TemplateStringsArray | undefined;
  return (parts ?? ([] as unknown as TemplateStringsArray)).join(' ? ');
}

const ROWS = [
  {
    id: 'acc-1', account_code: '1110', account_name: 'Bank - Primary',
    is_active: true, gl_balance: '3353164.26', posted_through: '2026-08-24T10:00:00.000Z',
  },
  {
    id: 'acc-2', account_code: '1140', account_name: 'Old Paycard',
    is_active: false, gl_balance: '6550.00', posted_through: '2026-02-01T08:00:00.000Z',
  },
  {
    id: 'acc-3', account_code: '1120', account_name: 'Dormant',
    is_active: true, gl_balance: '0', posted_through: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue(ROWS);
});

describe('getCashBalance', () => {
  it('sums the GL balance of every bank-subtype account', async () => {
    const result = await getCashBalance(COMPANY, '2026-08-31');
    expect(result.total).toBeCloseTo(3359714.26, 2);
    expect(result.accounts).toHaveLength(3);
  });

  it('NEVER filters on is_active — a deactivated account still holds money', async () => {
    await getCashBalance(COMPANY, '2026-08-31');
    expect(sqlText()).not.toMatch(/is_active\s*=/);
  });

  it('includes the deactivated account in the total and names it separately', async () => {
    const result = await getCashBalance(COMPANY, '2026-08-31');
    expect(result.accounts.map((a) => a.accountCode)).toContain('1140');
    expect(result.deactivatedWithBalance.map((a) => a.accountCode)).toEqual(['1140']);
  });

  it('does not report a deactivated account whose balance is nil', async () => {
    mockSql.mockResolvedValue([
      { id: 'x', account_code: '1199', account_name: 'Closed', is_active: false, gl_balance: '0', posted_through: null },
    ]);
    const result = await getCashBalance(COMPANY, '2026-08-31');
    expect(result.deactivatedWithBalance).toEqual([]);
  });

  it('scopes by company_id and bounds by the reporting date', async () => {
    await getCashBalance(COMPANY, '2026-08-31');
    expect(sqlText()).toMatch(/company_id/);
    expect(sqlText()).toMatch(/entry_date\s*<=/);
    expect(mockSql.mock.calls[0]?.slice(1)).toContain(COMPANY);
    expect(mockSql.mock.calls[0]?.slice(1)).toContain('2026-08-31');
  });

  it('counts posted journals only — a draft is not cash', async () => {
    await getCashBalance(COMPANY, '2026-08-31');
    expect(sqlText()).toMatch(/status\s*=\s*'posted'/);
  });

  it('selects by SUBTYPE, not by accounts named like banks', async () => {
    await getCashBalance(COMPANY, '2026-08-31');
    expect(sqlText()).toMatch(/account_subtype\s*=\s*ANY/);
    expect(sqlText()).not.toMatch(/account_name\s+ILIKE/i);
  });

  it('takes the cash vocabulary from CASH_SUBTYPES, not from two literals', async () => {
    // Asserted on the BOUND PARAMETER, not on the SQL text. A text assertion
    // here passed while the query read `IN ('bank', 'cash')` — which is not the
    // same set: it misses `bank_account`, `cash_on_hand` and `petty_cash`, all
    // spellings this schema accepts. No production account carries one today
    // (98 `bank`, 9 `cash`), so this changes no live figure; it stops the
    // opening-cash and cash-movement queries in cashFlowDirectService from
    // disagreeing about what counts as cash.
    await getCashBalance(COMPANY, '2026-08-31');
    const bound = mockSql.mock.calls[0]?.slice(1) ?? [];
    const arrays = bound.filter((v): v is string[] => Array.isArray(v));

    // The array param is located by TYPE, not by index, so it survives a
    // reordering of the template. That only identifies it while exactly one
    // array is bound — so assert that, rather than let a future second array
    // silently hand the assertions below the wrong parameter.
    expect(arrays).toHaveLength(1);

    // Compared against a HARDCODED list, not against CASH_SUBTYPES itself.
    // `toEqual([...CASH_SUBTYPES])` would compare the bound value to the same
    // imported array and pass whatever that array contained — restating the
    // import rather than testing it. If accountSubtypes legitimately gains a
    // cash spelling, this line is meant to go red and be updated deliberately.
    expect(arrays[0]).toEqual(['bank', 'bank_account', 'cash', 'cash_on_hand', 'petty_cash']);
  });

  it('keeps an account whose only lines are drafts, at zero rather than absent', async () => {
    await getCashBalance(COMPANY, '2026-08-31');
    // The LEFT JOIN's status predicate leaves je.id NULL for a draft line. The
    // CASE turns that into 0; a WHERE would have deleted the whole account.
    expect(sqlText()).toMatch(/CASE WHEN je\.id IS NULL THEN 0/);
    expect(sqlText()).not.toMatch(/WHERE[\s\S]*je\.id IS NOT NULL/);
  });

  it('reports posted_through as the latest ledger write, never now()', async () => {
    const result = await getCashBalance(COMPANY, '2026-08-31');
    expect(result.postedThrough).toBe('2026-08-24T10:00:00.000Z');
    expect(sqlText()).not.toMatch(/\bnow\(\)/i);
  });

  it('returns a null posted_through, not a timestamp, when nothing is posted', async () => {
    mockSql.mockResolvedValue([
      { id: 'x', account_code: '1110', account_name: 'Bank', is_active: true, gl_balance: '0', posted_through: null },
    ]);
    const result = await getCashBalance(COMPANY, '2026-08-31');
    expect(result.postedThrough).toBeNull();
  });

  it('returns zero and no accounts for a company with no bank accounts', async () => {
    mockSql.mockResolvedValue([]);
    const result = await getCashBalance(COMPANY, '2026-08-31');
    expect(result).toMatchObject({ total: 0, accounts: [], deactivatedWithBalance: [], postedThrough: null });
  });

  it('echoes the reporting date it was asked for', async () => {
    const result = await getCashBalance(COMPANY, '2026-08-31');
    expect(result.asAt).toBe('2026-08-31');
  });

  it('handles a Date posted_through — pg returns Date for timestamp columns', async () => {
    mockSql.mockResolvedValue([
      { id: 'x', account_code: '1110', account_name: 'Bank', is_active: true,
        gl_balance: '1', posted_through: new Date('2026-05-05T06:00:00Z') },
    ]);
    const result = await getCashBalance(COMPANY, '2026-08-31');
    expect(result.postedThrough).toBe('2026-05-05T06:00:00.000Z');
  });
});

describe('getCashBalance — exclusive bound', () => {
  it('bounds the date exclusively when asked, for an opening balance', async () => {
    await getCashBalance(COMPANY, '2026-04-01', { exclusive: true });
    // The flag is interpolated, not string-concatenated into the SQL: the
    // branch lives in a CASE so the query text is identical either way.
    expect(sqlText()).toMatch(/CASE WHEN/);
    expect(mockSql.mock.calls[0]?.slice(1)).toContain(true);
  });

  it('is inclusive by default', async () => {
    await getCashBalance(COMPANY, '2026-04-01');
    expect(mockSql.mock.calls[0]?.slice(1)).toContain(false);
  });
});
