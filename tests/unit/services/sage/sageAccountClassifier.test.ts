import { describe, expect, it } from 'vitest';
import { classifySageAccount, sageSystemRole } from '@/modules/accounting/services/sage/sageAccountClassifier';
import type { SageAccount } from '@/modules/accounting/services/sage/sageApiTypes';

const acct = (over: Partial<SageAccount> & { cat?: string }): SageAccount => ({
  ID: 100, Name: 'Test', Active: true, AccountType: 1,
  Category: over.cat === undefined ? { ID: 99, Description: 'Expenses' } : { ID: 99, Description: over.cat },
  ...over,
});

describe('classifySageAccount — by category DESCRIPTION, never by id', () => {
  // Real Sage SA ids on 2026-10-21: 7 = Non-Current Liabilities, 9 = Owners Equity.
  // The old id map read 7 as equity and 9 as liability. Ids must not matter.
  it.each([
    ['Sales', 'revenue', 'credit', 'revenue'],
    ['Other Income', 'revenue', 'credit', 'other'],
    ['Cost of Sales', 'expense', 'debit', 'cost_of_sales'],
    ['Expenses', 'expense', 'debit', 'operating_expense'],
    ['Income Tax', 'expense', 'debit', 'other'],
    ['Non-Current Assets', 'asset', 'debit', 'fixed_asset'],
    ['Fixed Assets', 'asset', 'debit', 'fixed_asset'],
    ['Current Assets', 'asset', 'debit', 'other_current_asset'],
    ['Non-Current Liabilities', 'liability', 'credit', 'long_term_liability'],
    ['Long Term Liabilities', 'liability', 'credit', 'long_term_liability'],
    ['Current Liabilities', 'liability', 'credit', 'other_current_liability'],
    ['Owners Equity', 'equity', 'credit', 'equity'],
    ["Owner's Equity", 'equity', 'credit', 'equity'],
  ])('%s → %s / %s / %s', (cat, type, normal, subtype) => {
    const c = classifySageAccount(acct({ cat, Category: { ID: 7, Description: cat } }));
    expect(c).toEqual({ ok: true, accountType: type, normalBalance: normal, accountSubtype: subtype });
  });

  it('is case- and spacing-insensitive', () => {
    expect(classifySageAccount(acct({ Category: { ID: 1, Description: '  non current   LIABILITIES ' } })))
      .toMatchObject({ ok: true, accountType: 'liability' });
  });

  it('refines by account name inside a category', () => {
    expect(classifySageAccount(acct({ Name: 'Bank Charges', cat: 'Expenses' }))).toMatchObject({ accountSubtype: 'finance_cost' });
    expect(classifySageAccount(acct({ Name: 'Interest Paid', cat: 'Expenses' }))).toMatchObject({ accountSubtype: 'finance_cost' });
    expect(classifySageAccount(acct({ Name: 'Inventory', cat: 'Current Assets' }))).toMatchObject({ accountSubtype: 'inventory' });
    expect(classifySageAccount(acct({ Name: 'Petty Cash', cat: 'Current Assets' }))).toMatchObject({ accountSubtype: 'cash' });
    expect(classifySageAccount(acct({ Name: 'PAYE Payable', cat: 'Current Liabilities' }))).toMatchObject({ accountSubtype: 'tax' });
    expect(classifySageAccount(acct({ Name: 'Accumulated Depreciation - Vehicles', cat: 'Non-Current Assets' })))
      .toMatchObject({ accountType: 'asset', accountSubtype: 'other' });
  });

  it('a bank account (AccountType 3) is a bank asset whatever its category says', () => {
    expect(classifySageAccount(acct({ AccountType: 3, Name: 'ABSA Current', cat: 'Current Assets' })))
      .toEqual({ ok: true, accountType: 'asset', normalBalance: 'debit', accountSubtype: 'bank' });
  });

  it('never assigns a reserved system subtype (those come only from the role map)', () => {
    const reserved = ['vat_input', 'vat_output', 'receivable', 'payable', 'retained_earnings', 'opening_balance_equity',
      'default_revenue', 'other_income', 'default_expense', 'admin_expense', 'accumulated_depreciation', 'depreciation_expense'];
    for (const cat of ['Sales', 'Other Income', 'Expenses', 'Current Assets', 'Non-Current Assets', 'Current Liabilities', 'Owners Equity']) {
      for (const Name of ['Depreciation', 'Accumulated Depreciation', 'VAT', 'Retained Income', 'Admin Expenses']) {
        const c = classifySageAccount(acct({ Name, cat }));
        if (c.ok) expect(reserved).not.toContain(c.accountSubtype);
      }
    }
  });

  it('an unknown or missing category is refused with a reason, not guessed', () => {
    expect(classifySageAccount(acct({ cat: 'Weird Stuff' }))).toEqual({ ok: false, reason: 'Unknown Sage account category "Weird Stuff"' });
    expect(classifySageAccount({ ID: 1, Name: 'X', Active: true, AccountType: 1, Category: null }))
      .toEqual({ ok: false, reason: 'Sage gave no account category' });
  });
});

describe('sageSystemRole — Sage system account ids to IsaFlow roles', () => {
  it.each([
    [-7, 'receivable'], [-8, 'payable'], [-9, 'vat_output'], [-11, 'retained_earnings'],
    [-1, 'default_revenue'], [-2, 'default_expense'],
  ])('%i → %s', (id, role) => expect(sageSystemRole(id)).toBe(role));

  it('other ids have no role', () => {
    for (const id of [-3, -13, -10, 5, 0, 1093996]) expect(sageSystemRole(id)).toBeNull();
  });
});

// M7 makes a refused COA row refuse the whole Sage import, so every subtype the
// classifier can give must be one the COA step accepts for that type.
describe('every classification is one the COA step accepts', () => {
  it.each([
    'Sales', 'Revenue', 'Other Income', 'Cost of Sales', 'Expenses', 'Income Tax', 'Non-Current Assets', 'Fixed Assets',
    'Current Assets', 'Non-Current Liabilities', 'Long Term Liabilities', 'Current Liabilities', 'Owners Equity', 'Equity',
  ])('%s, under every name rule', async (category) => {
    const { subtypeErrorFor } = await import('@/modules/accounting/services/gl/accountSubtypeRules');
    for (const name of ['Plain', 'Bank Charges', 'Interest Paid', 'Accumulated Depreciation', 'Inventory', 'Petty Cash', 'PAYE Payable']) {
      const c = classifySageAccount({ ID: 1, Name: name, Category: { ID: 1, Description: category }, Active: true, AccountType: 1 });
      expect(c.ok).toBe(true);
      if (c.ok) expect(subtypeErrorFor({ accountType: c.accountType }, c.accountSubtype)).toBeNull();
    }
  });
});
