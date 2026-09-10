/**
 * A GL account carrying money cannot be deactivated.
 *
 * `is_active` is a chart-of-accounts picker flag, and every balance query now
 * reports an inactive account's money rather than hiding it. That closes the
 * reporting hole but not the cause: four accounts reached production
 * deactivated while still holding R137,317.39 between them, because
 * `updateAccount` set `is_active` with no balance check at all. `deleteAccount`
 * already refused — the edit path did not, so the CoA edit form, the bulk PUT
 * and the MCP update tool could all do what the delete path forbade.
 *
 * The rules:
 *   - deactivating an account with a non-zero POSTED balance is refused, and
 *     the message names the balance so the user knows what to clear;
 *   - deactivating a zero-balance account stays possible (closing a used but
 *     reconciled account is normal);
 *   - REACTIVATION is never blocked — an account holding money is exactly the
 *     one you may need to switch back on;
 *   - an edit that does not touch `is_active` never pays for a balance query.
 *
 * "Balance" is the trial balance's definition: posted entries only, scoped by
 * company on both the entry and the line, SUM(debit) - SUM(credit). It is
 * computed from the ledger rather than read from the `gl_account_balances`
 * cache -- not because that cache is wrong (it is currently accurate, and
 * `trg_gl_je_status_balance` keeps it so across the draft <-> posted flip) but
 * because a guard deciding whether money exists is a safety property and
 * should not inherit an optimisation's failure modes.
 *
 * Query/pure helper tests stay local. Issued writer financial cases live in
 * tests/integration/controls/glEightControl.int.test.ts using real posted journals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/cache', () => ({ cache: { invalidatePrefix: vi.fn(), get: vi.fn(), set: vi.fn() } }));

import { updateAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { getPostedAccountBalance, holdsMoney, formatAccountBalance } from '@/modules/accounting/services/gl/glAccountBalance';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCOUNT = 'bbbbbbbb-0000-0000-0000-000000000001';

const ACCOUNT_ROW = { id: ACCOUNT, is_system_account: false, account_name: 'Loan Account - Blitz Fibre', is_active: true };

/** Joined template text with SQL comments stripped and whitespace collapsed. */
function texts(): string[] {
  return sqlMock.mock.calls.map((c) =>
    (c[0] as readonly string[]).join(' ? ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' '),
  );
}

const balanceQueries = () => texts().filter((q) => /debit_total/i.test(q));

/**
 * Sequences the mock: the account lookup, then the balance, then the UPDATE.
 * `debit`/`credit` are the posted totals the balance helper should read.
 */
function seed({ debit, credit }: { debit: number; credit: number }) {
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join(' ');
    if (/debit_total/i.test(q)) return [{ debit_total: String(debit), credit_total: String(credit) }];
    if (/UPDATE gl_accounts/i.test(q)) return [{ ...ACCOUNT_ROW, is_active: false }];
    return [ACCOUNT_ROW];
  });
}

beforeEach(() => seed({ debit: 0, credit: 0 }));

describe('getPostedAccountBalance', () => {
  it('nets posted debits against credits', async () => {
    seed({ debit: 130000, credit: 0 });
    await expect(getPostedAccountBalance(COMPANY, ACCOUNT)).resolves.toBeCloseTo(130000, 2);

    seed({ debit: 100, credit: 417.39 });
    await expect(getPostedAccountBalance(COMPANY, ACCOUNT)).resolves.toBeCloseTo(-317.39, 2);
  });

  it('counts posted entries only and scopes both the entry and the line by company', async () => {
    await getPostedAccountBalance(COMPANY, ACCOUNT);

    const [q] = balanceQueries();
    expect(q).toBeDefined();
    // Draft lines are not money yet, and the trial balance does not count
    // them. Without the JOIN they would leak in and the guard would disagree
    // with the report the user is looking at.
    expect(q!).toMatch(/JOIN gl_journal_entries je ON je\.id = jl\.journal_entry_id/i);
    expect(q!).toMatch(/je\.status = 'posted'/);
    expect(q!).toMatch(/jl\.company_id = \?/);
    expect(q!).toMatch(/je\.company_id = \?/);
    // The gl_account_balances cache is not a source of truth.
    expect(q!).not.toMatch(/gl_account_balances/i);
  });
});

describe('controlled account writer ingress', () => {
  it('refuses an unissued update before any SQL, including a supplied company/account', async () => {
    sqlMock.mockClear();
    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: false }))
      .rejects.toThrow('Authenticated control transaction required');
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

// Persisted GL amounts are cent-scaled. Keep the former sub-cent mock case
// as a direct test of the real guard rather than inventing fractional PG money.
describe('posted account balance tolerance', () => {
  it('tolerates the original sub-cent rounding dust and both exact half-cent boundaries', () => {
    expect(holdsMoney(1000 - 1000.004)).toBe(false);
    for (const balance of [0, 0.004, -0.004, 0.005, -0.005]) {
      expect(holdsMoney(balance)).toBe(false);
    }
    for (const balance of [0.005001, -0.005001, 130000, -450]) {
      expect(holdsMoney(balance)).toBe(true);
    }
    expect(formatAccountBalance(130000)).toBe('130000.00');
    expect(formatAccountBalance(-450)).toBe('-450.00');
  });
});
