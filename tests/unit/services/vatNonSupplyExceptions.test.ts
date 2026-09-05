/**
 * The rule that would have caught R400,388.14 of input tax manufactured on a
 * salary run (Velocity Fibre, 29 posted journals, found 2026-09-05).
 *
 * These exercise the pure predicate, so they run with no database. Every
 * negative case below is a real production account name that IS a supply and
 * must stay unflagged — deleting a pattern turns a positive red, widening one
 * turns a negative red.
 */

import { describe, it, expect } from 'vitest';
import {
  NON_CLAIMING_VAT_TYPES,
  NON_SUPPLY_PATTERN,
  classifyNonSupplyAccount,
  isNonSupplyVatException,
  mapVatNonSupplyLine,
  toJsRegExp,
} from '@/modules/accounting/services/reports/vatNonSupplyExceptions';

describe('classifyNonSupplyAccount', () => {
  it.each([
    ['Salaries & Wages - EX4000', 'employment_cost'],
    ['Salary Control', 'employment_cost'],
    ['COS - Casual wages - EX2009', 'employment_cost'],
    ['PAYE Payable', 'employment_cost'],
    ['UIF Payable', 'employment_cost'],
    ['SDL Payable', 'employment_cost'],
    ['Income Tax', 'tax_or_penalty'],
    ['Fines & Penalties - EX5014', 'tax_or_penalty'],
    ['SARS Penalties and Interest', 'tax_or_penalty'],
    ['Dividends Declared', 'distribution'],
    ['Drawings', 'distribution'],
    ['Depreciation - Computers Equipment - EX3004', 'depreciation'],
    ['Amortisation of Intangibles', 'depreciation'],
    ['Donations', 'donation'],
    ['Interest Received', 'financial_service'],
    ['Investment - Blitz Fibre (Pty) Ltd', 'financial_service'],
    ['Loan Account - H10 Holdings (Pty) Ltd', 'financial_service'],
  ])('classifies %s as %s', (name, reason) => {
    expect(classifyNonSupplyAccount(name)).toBe(reason);
  });

  it.each([
    'Bank Charges - EX5006',
    'Insurance - EX5020',
    'Travelling & Accommodation - EX5046',
    'Entertainment - EX5013',
    'Staff Welfare - EX5040',
    'Consulting Fees',
    'Computer Expenses',
    'Rent Premises - EX5033',
    'Subscriptions',
    'Repairs & Maintenance',
  ])('leaves the real supply %s unflagged', (name) => {
    expect(classifyNonSupplyAccount(name)).toBeNull();
  });

  it('orders penalties ahead of interest so a combined account reads as tax', () => {
    // "SARS Penalties and Interest" matches both patterns; first match wins.
    expect(classifyNonSupplyAccount('SARS Penalties and Interest')).toBe('tax_or_penalty');
  });
});

describe('isNonSupplyVatException', () => {
  it('flags the production defect: standard-rated salaries', () => {
    expect(isNonSupplyVatException({
      accountName: 'Salaries & Wages - EX4000', vatType: 'standard',
    })).toBe(true);
  });

  it('flags output VAT on the disposal of a share investment', () => {
    expect(isNonSupplyVatException({
      accountName: 'Investment - Blitz Fibre (Pty) Ltd', vatType: 'standard',
    })).toBe(true);
  });

  it('flags a zero-rated code too — that still claims a supply value in box 2', () => {
    expect(isNonSupplyVatException({
      accountName: 'Salaries & Wages', vatType: 'zero_rated',
    })).toBe(true);
  });

  it('does NOT flag an uncoded line — query 1 owns those', () => {
    expect(isNonSupplyVatException({
      accountName: 'Salaries & Wages', vatType: null,
    })).toBe(false);
  });

  // Named literally, not driven off NON_CLAIMING_VAT_TYPES: a test that reads
  // the constant it is checking shrinks silently when the constant does.
  it('does NOT flag exempt — interest received IS correctly coded exempt', () => {
    expect(isNonSupplyVatException({ accountName: 'Interest Received', vatType: 'exempt' })).toBe(false);
  });

  it('does NOT flag no_vat — the line was explicitly coded as carrying none', () => {
    expect(isNonSupplyVatException({ accountName: 'Interest Received', vatType: 'no_vat' })).toBe(false);
  });

  it('pins the full set of non-claiming codes', () => {
    expect([...NON_CLAIMING_VAT_TYPES]).toEqual(['no_vat', 'exempt']);
  });

  it('does NOT flag standard VAT on a genuine supply', () => {
    expect(isNonSupplyVatException({
      accountName: 'Bank Charges - EX5006', vatType: 'standard',
    })).toBe(false);
  });
});

describe('the loan anchor', () => {
  // Every other acronym in the pattern list is anchored at both ends; this one
  // was anchored only at the start, so it matched mid-word suffixes.
  it('matches the singular and the plural account names', () => {
    expect(classifyNonSupplyAccount('Loan - RL2 Holdings - BA8807')).toBe('financial_service');
    expect(classifyNonSupplyAccount('Long-term Loans')).toBe('financial_service');
    expect(classifyNonSupplyAccount('Shareholder loan - Blitz Fibre')).toBe('financial_service');
  });

  it('does not match a word that merely ends in loan', () => {
    expect(classifyNonSupplyAccount('Loanword Services')).toBeNull();
    expect(classifyNonSupplyAccount('Sloane Street Rent')).toBeNull();
  });
});

describe('toJsRegExp', () => {
  it('translates the Postgres word-boundary spellings JavaScript would swallow', () => {
    // Untranslated, JS reads \m as a literal "m" and matches nothing.
    expect(toJsRegExp('\\mpaye\\M').test('PAYE Payable')).toBe(true);
    expect(toJsRegExp('\\mpaye\\M').test('repayment')).toBe(false);
    expect(new RegExp('\\mpaye\\M', 'i').test('PAYE Payable')).toBe(false);
  });
});

describe('NON_SUPPLY_PATTERN', () => {
  it('is the union the SQL filters on, so it matches whatever the classifier does', () => {
    const re = toJsRegExp(NON_SUPPLY_PATTERN);
    for (const name of ['Salaries & Wages', 'Depreciation', 'Donations', 'Income Tax', 'Drawings']) {
      expect(re.test(name)).toBe(true);
      expect(classifyNonSupplyAccount(name)).not.toBeNull();
    }
    for (const name of ['Bank Charges', 'Consulting Fees']) {
      expect(re.test(name)).toBe(false);
      expect(classifyNonSupplyAccount(name)).toBeNull();
    }
  });
});

describe('mapVatNonSupplyLine', () => {
  it('coerces pg strings and carries the reason', () => {
    expect(mapVatNonSupplyLine({
      journal_entry_id: 'je-1',
      entry_number: 'JE-0009',
      entry_date: '2026-03-25',
      account_code: '49784360',
      account_name: 'Salaries & Wages - EX4000',
      vat_type: 'standard',
      description: 'Salary run',
      amount: '2669254.374',
      journal_vat: '400388.14',
      total_count: '29',
    })).toEqual({
      journalEntryId: 'je-1',
      entryNumber: 'JE-0009',
      entryDate: '2026-03-25',
      accountCode: '49784360',
      accountName: 'Salaries & Wages - EX4000',
      reason: 'employment_cost',
      vatType: 'standard',
      description: 'Salary run',
      amount: 2669254.37,
      journalVat: 400388.14,
    });
  });

  it('carries the journal VAT separately from the contra amount', () => {
    // The whole point: the flagged line shows the salary cost, and the number
    // that is actually wrong is the tax leg beside it.
    const row = mapVatNonSupplyLine({
      journal_entry_id: 'je-2', entry_number: 'JE-0010', entry_date: '2025-04-01',
      account_code: '49784360', account_name: 'Salaries & Wages - EX4000',
      vat_type: 'standard', description: '', amount: '62486.96',
      journal_vat: '9373.04', total_count: '1',
    });
    expect(row.amount).toBe(62486.96);
    expect(row.journalVat).toBe(9373.04);
  });

  it('reports zero journal VAT rather than NaN when the entry has no VAT leg', () => {
    const row = mapVatNonSupplyLine({
      journal_entry_id: 'je-3', entry_number: 'JE-0011', entry_date: '2025-04-01',
      account_code: '5820', account_name: 'Depreciation Expense',
      vat_type: 'zero_rated', description: '', amount: '1000',
      journal_vat: null, total_count: '1',
    });
    expect(row.journalVat).toBe(0);
  });
});
