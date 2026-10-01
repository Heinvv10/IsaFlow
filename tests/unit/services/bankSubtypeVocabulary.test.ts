/**
 * One definition of "does this account hold bank transactions?".
 *
 * Round 4 review, MEDIUM-1: the question was asked with two vocabularies. Every
 * bank query matched the literal `'bank'`; `cash.balance.v1` matched
 * `CASH_SUBTYPES`, which also contains the raw spelling `bank_account`. An
 * asset-typed account spelled `bank_account` was therefore cash with no bank
 * coverage row at all. The SQL sites now pass `BANK_SUBTYPES`, and the paths
 * that compare in TypeScript call `isBankSubtype` — this file pins that the two
 * forms cannot drift apart, and that BANK_SUBTYPES stays inside CASH_SUBTYPES.
 */
import { describe, expect, it } from 'vitest';
import {
  BANK_SUBTYPES,
  CASH_SUBTYPES,
  isBankSubtype,
  canonicalSubtype,
} from '@/modules/accounting/services/gl/accountSubtypes';

describe('the bank-account vocabulary', () => {
  it('contains more than the literal `bank`', () => {
    // The whole defect: the literal excluded a spelling the schema accepts.
    expect(BANK_SUBTYPES).toContain('bank');
    expect(BANK_SUBTYPES).toContain('bank_account');
  });

  it('agrees with its predicate form on every spelling it lists', () => {
    for (const spelling of BANK_SUBTYPES) expect(isBankSubtype(spelling)).toBe(true);
  });

  it('rejects everything that is not a bank account, petty cash included', () => {
    for (const spelling of ['cash', 'petty_cash', 'cash_on_hand', 'receivable',
      'other_current_asset', 'equity', 'fixed_assets', '', null, undefined]) {
      expect(isBankSubtype(spelling)).toBe(false);
    }
  });

  it('is a strict subset of cash and cash equivalents', () => {
    // Coverage may not list an account cash does not count, and cash may not
    // count a bank-subtype asset coverage does not list.
    for (const spelling of BANK_SUBTYPES) expect(CASH_SUBTYPES).toContain(spelling);
    expect(CASH_SUBTYPES.length).toBeGreaterThan(BANK_SUBTYPES.length);
  });

  it('lists exactly the spellings that canonicalise to `bank`', () => {
    // The SQL form is a fixed array; the predicate canonicalises. Anything the
    // predicate accepts that the array omits is an id one side would refuse.
    for (const spelling of CASH_SUBTYPES) {
      expect(BANK_SUBTYPES.includes(spelling)).toBe(canonicalSubtype(spelling) === 'bank');
    }
  });
});
