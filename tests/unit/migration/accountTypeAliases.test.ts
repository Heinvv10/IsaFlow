/**
 * The CoA wizard step must understand the account types Sage / Pastel exports
 * carry ("Current Assets", "Cost of Sales", "Owners Equity", ...). They used to
 * reach gl_accounts verbatim and surface as a raw CHECK-constraint error, and a
 * file without a normal_balance column imported every account as a debit.
 */
import { describe, it, expect } from 'vitest';
import {
  translateAccountType,
  normalBalanceForType,
  resolveCoaImportRows,
} from '@/modules/accounting/services/core/accountTypeAliases';

describe('translateAccountType', () => {
  it.each([
    ['asset', 'asset'], ['Asset', 'asset'], ['ASSETS', 'asset'],
    ['Current Assets', 'asset'], ['Non-Current Assets', 'asset'], ['Fixed Assets', 'asset'],
    ['Liability', 'liability'], ['Current Liabilities', 'liability'], ['Non-Current Liabilities', 'liability'],
    ['Equity', 'equity'], ['Owners Equity', 'equity'], ["Owner's Equity", 'equity'],
    ['Revenue', 'revenue'], ['Sales', 'revenue'], ['Other Income', 'revenue'], ['Income', 'revenue'],
    ['Expense', 'expense'], ['Expenses', 'expense'], ['Cost of Sales', 'expense'], ['Income Tax', 'expense'],
  ])('translates %j to %s', (raw, expected) => {
    expect(translateAccountType(raw)?.type).toBe(expected);
  });

  it('suggests the income-statement subtype the alias implies', () => {
    expect(translateAccountType('Cost of Sales')?.subtype).toBe('cost_of_sales');
    expect(translateAccountType('Sales')?.subtype).toBe('revenue');
    expect(translateAccountType('Expenses')?.subtype).toBe('operating_expense');
    expect(translateAccountType('Other Income')?.subtype).toBe('other');
  });

  it('returns null for a type it does not know', () => {
    expect(translateAccountType('Widgets')).toBeNull();
    expect(translateAccountType('')).toBeNull();
  });
});

describe('normalBalanceForType', () => {
  it('derives the normal balance from the type', () => {
    expect(normalBalanceForType('asset')).toBe('debit');
    expect(normalBalanceForType('expense')).toBe('debit');
    expect(normalBalanceForType('liability')).toBe('credit');
    expect(normalBalanceForType('equity')).toBe('credit');
    expect(normalBalanceForType('revenue')).toBe('credit');
  });
});

describe('resolveCoaImportRows', () => {
  const row = (accountType: string, normalBalance = '', accountSubtype?: string) => ({
    accountCode: '4000', accountName: 'Sales', accountType, normalBalance, accountSubtype,
  });

  it('translates the type and derives the normal balance when none is given', () => {
    const { accounts, errors } = resolveCoaImportRows([row('Sales'), row('Current Liabilities')]);
    expect(errors).toEqual([]);
    expect(accounts[0]).toMatchObject({ accountType: 'revenue', normalBalance: 'credit', accountSubtype: 'revenue' });
    expect(accounts[1]).toMatchObject({ accountType: 'liability', normalBalance: 'credit' });
    expect(accounts[1]!.accountSubtype).toBeUndefined();
  });

  it('keeps an explicit subtype and an explicit normal balance', () => {
    const { accounts } = resolveCoaImportRows([row('Expenses', 'Credit', 'finance_cost')]);
    expect(accounts[0]).toMatchObject({ accountType: 'expense', normalBalance: 'credit', accountSubtype: 'finance_cost' });
  });

  it('reads Dr / Cr as a normal balance', () => {
    const { accounts } = resolveCoaImportRows([row('Asset', 'Dr'), row('Equity', 'CR')]);
    expect(accounts.map(a => a.normalBalance)).toEqual(['debit', 'credit']);
  });

  it('gives a friendly per-row error for an unknown type, and keeps the other rows', () => {
    const { accounts, errors, sourceRows } = resolveCoaImportRows([row('Widgets'), row('Asset')]);
    expect(accounts).toHaveLength(1);
    expect(sourceRows).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ step: 'coa', row: 0, field: 'accountType' });
    expect(errors[0]!.message).toContain('Widgets');
    expect(errors[0]!.message).toMatch(/asset/i);
  });

  it('gives a per-row error for a normal balance it cannot read', () => {
    const { accounts, errors } = resolveCoaImportRows([row('Asset', 'sideways')]);
    expect(accounts).toHaveLength(0);
    expect(errors[0]).toMatchObject({ row: 0, field: 'normalBalance' });
  });
});
