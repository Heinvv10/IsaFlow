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
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/cache', () => ({ cache: { invalidatePrefix: vi.fn(), get: vi.fn(), set: vi.fn() } }));

import { updateAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { getPostedAccountBalance } from '@/modules/accounting/services/gl/glAccountBalance';

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

describe('updateAccount refuses to deactivate an account holding money', () => {
  it('throws and names the balance', async () => {
    seed({ debit: 130000, credit: 0 });

    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: false }))
      .rejects.toThrow(/Loan Account - Blitz Fibre/);
    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: false }))
      .rejects.toThrow(/130000\.00/);
  });

  it('refuses on a credit balance too, not just a debit one', async () => {
    seed({ debit: 0, credit: 450 });

    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: false }))
      .rejects.toThrow(/-450\.00/);
  });

  it('never runs the UPDATE when it refuses', async () => {
    seed({ debit: 130000, credit: 0 });

    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: false })).rejects.toThrow();
    expect(texts().filter((q) => /UPDATE gl_accounts/i.test(q))).toHaveLength(0);
  });

  it('allows deactivating an account reconciled back to zero', async () => {
    seed({ debit: 5000, credit: 5000 });

    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: false })).resolves.toBeDefined();
    expect(texts().some((q) => /UPDATE gl_accounts/i.test(q))).toBe(true);
  });

  it('tolerates sub-cent rounding dust rather than blocking on it', async () => {
    seed({ debit: 1000, credit: 1000.004 });

    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: false })).resolves.toBeDefined();
  });

  it('never blocks REACTIVATION, even with a live balance', async () => {
    seed({ debit: 130000, credit: 0 });

    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: true })).resolves.toBeDefined();
    expect(balanceQueries()).toHaveLength(0);
  });

  it('does not run a balance query for an edit that leaves is_active alone', async () => {
    seed({ debit: 130000, credit: 0 });

    await expect(updateAccount(COMPANY, ACCOUNT, { accountName: 'Renamed' })).resolves.toBeDefined();
    expect(balanceQueries()).toHaveLength(0);
  });

  it('still refuses to deactivate a system account, before looking at any balance', async () => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([{ ...ACCOUNT_ROW, is_system_account: true }]);

    await expect(updateAccount(COMPANY, ACCOUNT, { isActive: false }))
      .rejects.toThrow(/system account/i);
  });
});
