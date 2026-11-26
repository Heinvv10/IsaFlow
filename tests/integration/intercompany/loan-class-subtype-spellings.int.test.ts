/**
 * Intercompany loan class vs the subtype spellings production carries (#1880, 2026-11-26: singular/plural pairs, 346 NULLs). Migration 1059:
 * `intercompany_is_loan_class` accepts the plural of each allowed class (case and spacing are normalised on write by trigger 674, pinned below); NULL, an unrelated plural (current_assets, fixed_assets), a bank/cash spelling and a system account stay refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acct, co } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearSetup } from './allocation-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

async function classOf(type: 'asset' | 'liability', subtype: string | null, system = false): Promise<boolean> {
  const normal = type === 'asset' ? 'debit' : 'credit';
  await pool.query('UPDATE gl_accounts SET account_type = $2, normal_balance = $3, account_subtype = $4, is_system_account = $5 WHERE id = $1', [acct.aLoan, type, normal, subtype, system]);
  return (await pool.query('SELECT public.intercompany_is_loan_class($1, $2) AS ok', [acct.aLoan, co.A])).rows[0].ok as boolean;
}

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await mirrorCleanup(pool); }, 60000);

describe('liability spellings', () => {
  it.each([
    'current_liability', 'current_liabilities', 'other_current_liability', 'other_current_liabilities', 'long_term_liability', 'long_term_liabilities',
    'other',
  ])('%j is a loan class', async (s) => { expect(await classOf('liability', s)).toBe(true); });

  it.each([null, '', 'payable', 'accounts_payable', 'credit_card', 'vat_output', 'payroll_liability', 'non_current_liability'])('%j is not', async (s) => {
    expect(await classOf('liability', s)).toBe(false);
  });
  it('a system account never is, whatever the spelling', async () => { expect(await classOf('liability', 'current_liabilities', true)).toBe(false); });
});

describe('asset spellings', () => {
  it.each(['other_current_asset', 'other_current_assets', 'other'])('%j is a loan class', async (s) => { expect(await classOf('asset', s)).toBe(true); });

  it.each([null, '', 'current_assets', 'current_asset', 'fixed_assets', 'fixed_asset', 'receivable', 'receivables', 'bank', 'bank_account', 'cash', 'petty_cash', 'investment'])('%j is not', async (s) => {
    expect(await classOf('asset', s)).toBe(false);
  });
});

describe('case and spacing reach the function already normalised (trigger 674)', () => {
  it.each([' Current_Liabilities ', 'long-term liabilities', 'LONG TERM  LIABILITIES'])('%j is stored normalised and is a loan class', async (s) => {
    expect(await classOf('liability', s)).toBe(true);
    const stored = (await pool.query('SELECT account_subtype FROM gl_accounts WHERE id = $1', [acct.aLoan])).rows[0].account_subtype as string;
    expect(stored).toBe(stored.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  });
  it('whitespace only is stored as NULL and is not a loan class', async () => { expect(await classOf('liability', '   ')).toBe(false); });
});

describe('the other account types', () => {
  it.each(['equity', 'revenue', 'expense'] as const)('%s is never one', async (type) => {
    await pool.query('UPDATE gl_accounts SET account_type = $2, account_subtype = $3, is_system_account = false WHERE id = $1', [acct.aLoan, type, 'other']);
    expect((await pool.query('SELECT public.intercompany_is_loan_class($1, $2) AS ok', [acct.aLoan, co.A])).rows[0].ok).toBe(false);
  });
});
