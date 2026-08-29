/**
 * VAT claimed against a balance-sheet account is REPORTED, never blocked.
 *
 * The decision behind these tests: nothing in the codebase checks account type
 * when a VAT code is applied — not bank allocation, not manual journals, not AP
 * invoices, not the MCP tools. A hard reject would be the first such gate
 * anywhere and would refuse legitimate postings nobody has enumerated. So this
 * surfaces in the pre-filing exceptions report, which is read at the moment the
 * question is answerable.
 *
 * What the tests below actually pin is the EXCLUSION list, because that is what
 * makes the rule worth reading. Two exclusions are load-bearing:
 *
 *   1. The VAT control accounts themselves. `vat_input` is an asset and
 *      `vat_output` a liability, so every VAT-bearing journal has a
 *      balance-sheet leg by construction — without the exclusion the rule flags
 *      the entire ledger. Production had 2,042 such lines and zero genuine
 *      exceptions when this was written.
 *   2. Balance-sheet accounts that legitimately bear input VAT in South Africa:
 *      capital goods (fixed assets), trading stock (inventory) and prepayments.
 *      `VatType` already carries `capital_goods` and the VAT201 maps it to
 *      boxes 1A and 14, so the codebase already treats this as legitimate.
 *
 * The subtype-not-type detail is pinned explicitly: production carries 356
 * posted lines on a `vat_input` account typed `liability` rather than `asset`.
 * Excluding by account_type would have flagged every one of them.
 */
import { describe, it, expect } from 'vitest';
import {
  BALANCE_SHEET_TYPES,
  VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES,
  isVatOnBalanceSheetException,
  mapVatOnBalanceSheetLine,
} from '@/modules/accounting/services/reports/vatBalanceSheetExceptions';

const line = (
  accountType: string,
  accountSubtype: string | null,
  vatType: string | null = 'standard',
) => ({ accountType, accountSubtype, vatType });

describe('isVatOnBalanceSheetException — what gets flagged', () => {
  it('flags VAT coded against a bank account', () => {
    // A bank leg is a gross money movement, never a supply.
    expect(isVatOnBalanceSheetException(line('asset', 'bank'))).toBe(true);
  });

  it('flags VAT coded against the AR and AP control accounts', () => {
    // Both already carry gross amounts — a VAT code here double-counts.
    expect(isVatOnBalanceSheetException(line('asset', 'receivable'))).toBe(true);
    expect(isVatOnBalanceSheetException(line('liability', 'payable'))).toBe(true);
  });

  it('flags VAT coded against equity, retained earnings and accumulated depreciation', () => {
    expect(isVatOnBalanceSheetException(line('equity', 'equity'))).toBe(true);
    expect(isVatOnBalanceSheetException(line('equity', 'retained_earnings'))).toBe(true);
    expect(isVatOnBalanceSheetException(line('asset', 'accumulated_depreciation'))).toBe(true);
  });

  it('flags a balance-sheet account with no subtype at all', () => {
    // account_subtype is a free VARCHAR with no CHECK constraint, so null and
    // unrecognised values are both reachable. Neither is on the legitimate
    // list, so both are flagged rather than silently passed.
    expect(isVatOnBalanceSheetException(line('asset', null))).toBe(true);
    expect(isVatOnBalanceSheetException(line('liability', 'something_new'))).toBe(true);
  });

  it('flags every VAT type that represents an actual claim', () => {
    for (const vatType of ['standard', 'zero_rated', 'exempt', 'capital_goods', 'imported']) {
      expect(isVatOnBalanceSheetException(line('asset', 'bank', vatType)), vatType).toBe(true);
    }
  });
});

describe('isVatOnBalanceSheetException — what is deliberately NOT flagged', () => {
  it('never flags the VAT control accounts — every VAT journal has one', () => {
    expect(isVatOnBalanceSheetException(line('asset', 'vat_input'))).toBe(false);
    expect(isVatOnBalanceSheetException(line('liability', 'vat_output'))).toBe(false);
    expect(isVatOnBalanceSheetException(line('liability', 'tax'))).toBe(false);
  });

  it('excludes the VAT control accounts by SUBTYPE, not by account type', () => {
    // Production carries 356 posted lines on a vat_input account typed
    // 'liability' rather than 'asset'. A type-based exclusion flags them all.
    expect(isVatOnBalanceSheetException(line('liability', 'vat_input'))).toBe(false);
    expect(isVatOnBalanceSheetException(line('asset', 'vat_output'))).toBe(false);
  });

  it('never flags capital goods, trading stock or prepayments', () => {
    // SA input VAT on these is claimable — the supply is real, the account is
    // simply a balance-sheet one.
    expect(isVatOnBalanceSheetException(line('asset', 'fixed_asset'))).toBe(false);
    expect(isVatOnBalanceSheetException(line('asset', 'fixed_assets'))).toBe(false);
    expect(isVatOnBalanceSheetException(line('asset', 'inventory'))).toBe(false);
    expect(isVatOnBalanceSheetException(line('asset', 'other_current_asset'))).toBe(false);
  });

  it('never flags an income-statement account, whatever its subtype', () => {
    // This is the NORMAL place for a VAT-bearing contra leg.
    expect(isVatOnBalanceSheetException(line('expense', 'operating_expense'))).toBe(false);
    expect(isVatOnBalanceSheetException(line('revenue', 'default_revenue'))).toBe(false);
    expect(isVatOnBalanceSheetException(line('expense', null))).toBe(false);
  });

  it('never flags a line carrying no VAT', () => {
    expect(isVatOnBalanceSheetException(line('asset', 'bank', null))).toBe(false);
    expect(isVatOnBalanceSheetException(line('asset', 'bank', 'no_vat'))).toBe(false);
  });
});

describe('the exclusion constants', () => {
  it('covers exactly the balance-sheet account types', () => {
    // revenue and expense are the income statement and must never appear here,
    // or the rule stops flagging the balance sheet and starts flagging trading.
    expect([...BALANCE_SHEET_TYPES].sort()).toEqual(['asset', 'equity', 'liability']);
  });

  it('lists both spellings of the fixed-asset subtype', () => {
    // leafAccountValidator accepts either, so both reach gl_accounts.
    expect(VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES).toContain('fixed_asset');
    expect(VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES).toContain('fixed_assets');
  });
});

describe('mapVatOnBalanceSheetLine', () => {
  it('maps a row, coercing pg numeric strings and carrying the reason fields', () => {
    expect(mapVatOnBalanceSheetLine({
      journal_entry_id: 'je-7',
      entry_number: 'JE-2026-00007',
      entry_date: '2026-03-15',
      account_code: '1010',
      account_name: 'Bank - Primary',
      account_type: 'asset',
      account_subtype: 'bank',
      vat_type: 'standard',
      description: 'Input VAT coded to the bank leg',
      amount: '150.55',
      total_count: '1',
    })).toEqual({
      journalEntryId: 'je-7',
      entryNumber: 'JE-2026-00007',
      entryDate: '2026-03-15',
      accountCode: '1010',
      accountName: 'Bank - Primary',
      // Both carried so a reader can see WHY the line was flagged.
      accountType: 'asset',
      accountSubtype: 'bank',
      vatType: 'standard',
      description: 'Input VAT coded to the bank leg',
      amount: 150.55,
    });
  });

  it('preserves a null subtype rather than coercing it to the string "null"', () => {
    const mapped = mapVatOnBalanceSheetLine({
      journal_entry_id: 'je-8', account_subtype: null, amount: '0',
    });
    expect(mapped.accountSubtype).toBeNull();
  });

  it('reads a DATE that arrives as a string, which is how pg returns it now', () => {
    // Since the OID 1082 type parser landed, DATE columns come back as plain
    // 'YYYY-MM-DD' strings rather than Date objects. dateStr handles both.
    expect(mapVatOnBalanceSheetLine({ journal_entry_id: 'x', entry_date: '2026-07-01', amount: '0' })
      .entryDate).toBe('2026-07-01');
    expect(mapVatOnBalanceSheetLine({ journal_entry_id: 'x', entry_date: new Date(2026, 6, 1), amount: '0' })
      .entryDate).toBe('2026-07-01');
  });
});
