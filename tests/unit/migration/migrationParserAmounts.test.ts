/**
 * The external (Xero / QuickBooks / Pastel) wizard's parser and auto-map.
 *
 * - parseBalance stripped every comma, so a decimal-comma "1234,56" became
 *   123456, and garbage became 0. It now reads SA formats and flags garbage.
 * - "Auto-map" posted JSON.stringify(accounts) to the CSV parser as a file; the
 *   parser found no CSV rows and the wizard replaced the account list with [].
 *   remapAccounts works on the in-memory list and never empties it.
 * - Pastel / Sage account types ("Current Assets", "Cost of Sales") fall back to
 *   the shared alias table when the code range says nothing.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  parseAccountsFile,
  parseCustomersFile,
  remapAccounts,
  type ParsedAccount,
} from '@/modules/accounting/services/core/migrationParserService';

describe('parseAccountsFile — balances', () => {
  it('reads a decimal comma as a decimal, not a thousands separator', () => {
    const csv = 'AccNumber;Description;AccType;CurrentBalance\n1000000;Bank;Asset;1234,56\n';
    const [acct] = parseAccountsFile('pastel', csv);
    expect(acct!.openingBalance).toBeCloseTo(1234.56, 6);
  });

  it('reads R and thousands separators', () => {
    const csv = 'Code,Name,Type,Balance\n200,Sales,Revenue,"R 12 345.67"\n';
    const [acct] = parseAccountsFile('xero', csv);
    expect(acct!.openingBalance).toBeCloseTo(12345.67, 6);
  });

  it('flags an unreadable balance instead of importing 0', () => {
    const csv = 'Code,Name,Type,Balance\n200,Sales,Revenue,12abc\n';
    const [acct] = parseAccountsFile('xero', csv);
    expect(acct!.openingBalance).toBe(0);
    expect(acct!.parseError).toContain('12abc');
  });

  it('flags an unreadable contact balance', () => {
    const csv = 'Name,Balance\nAcme,??\n';
    const [c] = parseCustomersFile('pastel', csv);
    expect(c!.parseError).toContain('??');
  });
});

describe('remapAccounts', () => {
  const base: ParsedAccount = { sourceCode: '', sourceName: 'X', sourceType: '', openingBalance: 0 };

  it('maps in memory and never returns fewer accounts than it was given', () => {
    const accounts: ParsedAccount[] = [
      { ...base, sourceCode: '1000', sourceType: 'BANK' },
      { ...base, sourceCode: '', sourceType: 'mystery' },
    ];
    const out = remapAccounts('xero', accounts);
    expect(out).toHaveLength(2);
    expect(out[0]!.mappedType).toBe('asset');
    expect(out[1]!.mappedType).toBeUndefined();
  });

  it('keeps a mapping the operator already chose', () => {
    const accounts: ParsedAccount[] = [
      { ...base, sourceType: 'bank', mappedType: 'liability', mappedNormalBalance: 'credit' },
    ];
    expect(remapAccounts('xero', accounts)[0]!.mappedType).toBe('liability');
  });

  it('understands Sage / Pastel category names', () => {
    const out = remapAccounts('pastel', [{ ...base, sourceType: 'Cost of Sales' }, { ...base, sourceType: 'Owners Equity' }]);
    expect(out[0]).toMatchObject({ mappedType: 'expense', mappedNormalBalance: 'debit', mappedSubtype: 'cost_of_sales' });
    expect(out[1]).toMatchObject({ mappedType: 'equity', mappedNormalBalance: 'credit' });
  });

  it('returns an empty list unchanged', () => {
    expect(remapAccounts('xero', [])).toEqual([]);
  });
});
