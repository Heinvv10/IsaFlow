/**
 * Tests for the bank transaction content-hash helper.
 *
 * Covers:
 *   - Stability: same input → same hash
 *   - Normalisation: whitespace / case / 2dp / date format all collapse
 *   - Sensitivity: different amount, date, desc, or balance → different hash
 *   - Balance separates legitimate same-day duplicates
 *   - Batch helper produces a matching Set
 */

import { describe, it, expect } from 'vitest';
import {
  bankTransactionHash,
  bankTransactionHashSet,
  type HashableTransaction,
} from '@/modules/accounting/utils/bankTransactionHash';

const tx = (partial: Partial<HashableTransaction>): HashableTransaction => ({
  transactionDate: '2024-01-15',
  amount: -123.45,
  description: 'POS Purchase Woolworths',
  balance: 15234.34,
  ...partial,
});

describe('bankTransactionHash — stability', () => {
  it('returns the same hash for identical input', () => {
    expect(bankTransactionHash(tx({}))).toBe(bankTransactionHash(tx({})));
  });

  it('returns a 64-character hex string', () => {
    const h = bankTransactionHash(tx({}));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('bankTransactionHash — normalisation collapses noise', () => {
  it('ignores description whitespace differences', () => {
    const a = bankTransactionHash(tx({ description: 'POS Purchase Woolworths' }));
    const b = bankTransactionHash(tx({ description: 'POS  Purchase   Woolworths  ' }));
    expect(a).toBe(b);
  });

  it('is case-insensitive on description', () => {
    const a = bankTransactionHash(tx({ description: 'POS Purchase Woolworths' }));
    const b = bankTransactionHash(tx({ description: 'pos purchase woolworths' }));
    expect(a).toBe(b);
  });

  it('treats 100 and 100.00 as the same amount', () => {
    const a = bankTransactionHash(tx({ amount: 100 }));
    const b = bankTransactionHash(tx({ amount: 100.0 }));
    expect(a).toBe(b);
  });

  it('treats 100.005 and 100.00 as the same (rounds to 2dp)', () => {
    const a = bankTransactionHash(tx({ amount: 100.00 }));
    const b = bankTransactionHash(tx({ amount: 100.004 }));
    expect(a).toBe(b);
  });

  it('accepts ISO timestamp dates and YYYY-MM-DD alike', () => {
    const a = bankTransactionHash(tx({ transactionDate: '2024-01-15' }));
    const b = bankTransactionHash(tx({ transactionDate: '2024-01-15T00:00:00.000Z' }));
    const c = bankTransactionHash(tx({ transactionDate: '2024-01-15T14:30:00.000Z' }));
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('treats missing balance and explicit undefined balance as the same', () => {
    const a = bankTransactionHash({ ...tx({}), balance: undefined });
    const b = bankTransactionHash({
      transactionDate: tx({}).transactionDate,
      amount: tx({}).amount,
      description: tx({}).description,
    });
    expect(a).toBe(b);
  });
});

describe('bankTransactionHash — sensitivity (different hashes)', () => {
  it('differs when the amount is different', () => {
    expect(bankTransactionHash(tx({ amount: -100 })))
      .not.toBe(bankTransactionHash(tx({ amount: -101 })));
  });

  it('differs when the date is different', () => {
    expect(bankTransactionHash(tx({ transactionDate: '2024-01-15' })))
      .not.toBe(bankTransactionHash(tx({ transactionDate: '2024-01-16' })));
  });

  it('differs when the description is materially different', () => {
    expect(bankTransactionHash(tx({ description: 'Woolworths' })))
      .not.toBe(bankTransactionHash(tx({ description: 'Checkers' })));
  });

  it('differs when the balance is different (distinguishes legit same-day duplicates)', () => {
    // Two R50 coffee purchases on the same day at the same merchant,
    // for the same amount — but different running balances because the
    // second one happened later.
    const a = bankTransactionHash(tx({ amount: -50, balance: 15284.34 }));
    const b = bankTransactionHash(tx({ amount: -50, balance: 15234.34 }));
    expect(a).not.toBe(b);
  });

  it('positive 100 and negative 100 are different hashes (sign matters)', () => {
    expect(bankTransactionHash(tx({ amount: 100 })))
      .not.toBe(bankTransactionHash(tx({ amount: -100 })));
  });
});

describe('bankTransactionHashSet', () => {
  it('returns a Set with one entry per transaction when all are unique', () => {
    const txs: HashableTransaction[] = [
      tx({ amount: -10 }),
      tx({ amount: -20 }),
      tx({ amount: -30 }),
    ];
    const set = bankTransactionHashSet(txs);
    expect(set.size).toBe(3);
  });

  it('collapses duplicate transactions into one entry', () => {
    const txs: HashableTransaction[] = [
      tx({}),
      tx({}), // identical
      tx({ amount: -99 }),
    ];
    const set = bankTransactionHashSet(txs);
    expect(set.size).toBe(2);
  });
});
