import { describe, expect, it } from 'vitest';
import { isSageOpeningBalanceJournal } from '@/modules/accounting/services/sage/sageOpeningBalanceJournal';

describe('isSageOpeningBalanceJournal', () => {
  it("takes Sage's opening-balance description in any case, trailing punctuation and spaces ignored", () => {
    for (const d of ['O/B from other system', 'o/b FROM other SYSTEM', 'O/B from other system.', 'O/B from other system ;! ']) {
      expect(isSageOpeningBalanceJournal(d, null)).toBe(true);
    }
  });

  it('takes the opening-balance references in any case, surrounding spaces ignored', () => {
    for (const r of ['O/balance', 'o/BALANCE', ' O/B ', 'o/b']) expect(isSageOpeningBalanceJournal('Bank transfer', r)).toBe(true);
  });

  it('leaves the live history a GL import', () => {
    expect(isSageOpeningBalanceJournal('Bank transfer', 'INV001')).toBe(false);
    expect(isSageOpeningBalanceJournal('O/B from other system 2', null)).toBe(false);
    expect(isSageOpeningBalanceJournal('Re: O/B from other system', 'O/balances')).toBe(false);
    expect(isSageOpeningBalanceJournal(null, undefined)).toBe(false);
    expect(isSageOpeningBalanceJournal('', '')).toBe(false);
  });

  it('matches exactly, not by substring: the near misses migration 908 relabels are not opening balances', () => {
    expect(isSageOpeningBalanceJournal('O/B from other system 2', null)).toBe(false);
    expect(isSageOpeningBalanceJournal('Bank charges', 'O/balances')).toBe(false);
  });

  it('reads a numeric description or reference (untyped Sage JSON) without throwing', () => {
    expect(isSageOpeningBalanceJournal('Bank transfer', 10045)).toBe(false);
    expect(isSageOpeningBalanceJournal(0, 0)).toBe(false);
    expect(isSageOpeningBalanceJournal(12, 'O/B')).toBe(true);
  });
});
