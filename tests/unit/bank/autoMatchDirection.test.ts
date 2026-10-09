/**
 * Auto-match direction (register HIGH, brk-nrfa round 22). The GL lines auto-match is fed are the statement line's own
 * bank account's lines (bankAutoMatchService reads `jl.gl_account_id = bankAccountId`). Money IN debits a bank account
 * and money OUT credits it, so a deposit pairs with a bank DEBIT leg and a withdrawal with a bank CREDIT leg. The old
 * rule was inverted: a -650 payment matched a +650 receipt's leg and an exact -660 payment stayed unmatched.
 */
import { describe, expect, it } from 'vitest';
import { findMatchCandidates, runAutoMatch } from '@/modules/accounting/utils/autoMatch';

const DATE = '2026-05-20';
// The bank account's legs of three posted journals, all dated the statement date.
const receipt650 = { id: 'receipt-650', debit: 650, credit: 0, description: 'Receipt Acme', entryDate: DATE };
const payment650 = { id: 'payment-650', debit: 0, credit: 650, description: 'Payment Buildco', entryDate: DATE };
const payment660 = { id: 'payment-660', debit: 0, credit: 660, description: 'Payment Buildco', entryDate: DATE };
const bankLegs = [receipt650, payment650, payment660];

describe('auto-match direction: a deposit pairs with a bank DEBIT leg, a withdrawal with a bank CREDIT leg', () => {
  it('a +650 deposit is offered only the receipt\'s debit leg, never the payment\'s credit leg of the same amount', () => {
    const candidates = findMatchCandidates({ id: 'dep', amount: 650, transactionDate: DATE }, bankLegs);
    expect(candidates.map((c) => c.journalLineId)).toEqual(['receipt-650']);
  });

  it('a -660 payment is offered its own credit leg', () => {
    const candidates = findMatchCandidates({ id: 'wd', amount: -660, transactionDate: DATE }, bankLegs);
    expect(candidates.map((c) => c.journalLineId)).toEqual(['payment-660']);
  });

  it('a -650 payment is offered the payment\'s credit leg, not the +650 receipt\'s debit leg', () => {
    const candidates = findMatchCandidates({ id: 'wd650', amount: -650, transactionDate: DATE }, bankLegs);
    expect(candidates.map((c) => c.journalLineId)).toEqual(['payment-650']);
  });

  it('a line with only an opposite-direction leg of its amount gets no candidate', () => {
    expect(findMatchCandidates({ id: 'dep660', amount: 660, transactionDate: DATE }, bankLegs)).toEqual([]);
  });

  it('runAutoMatch pairs each statement line with its own-direction leg and leaves nothing unmatched', () => {
    const { matches, unmatched } = runAutoMatch([
      { id: 'dep', amount: 650, transactionDate: DATE },
      { id: 'wd', amount: -660, transactionDate: DATE },
    ], bankLegs);
    const paired = Object.fromEntries(matches.map((m) => [m.bankTransactionId, m.journalLineId]));
    expect(paired).toEqual({ dep: 'receipt-650', wd: 'payment-660' });
    expect(unmatched).toEqual([]);
  });
});
