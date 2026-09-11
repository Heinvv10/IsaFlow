import { describe, expect, it } from 'vitest';
import {
  assertFeedPosted, BankTransactionNotPostedError, feedStateOf, isBankTransactionNotPosted,
} from '@/modules/accounting/services/bank/bankFeedStateGuard';

describe('bankFeedStateGuard', () => {
  it('treats a row without feed_state as posted (pre-675 row shape)', () => {
    expect(feedStateOf({})).toBe('posted');
  });
  it('refuses a pending row with a typed, readable error', () => {
    let caught: unknown;
    try { assertFeedPosted({ id: 'tx-1', feed_state: 'pending' }, 'allocate'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BankTransactionNotPostedError);
    expect(isBankTransactionNotPosted(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/pending at the bank/);
    expect((caught as Error).message).toMatch(/allocate/);
  });
  it('refuses a removed row', () => {
    expect(() => assertFeedPosted({ id: 'tx-2', feed_state: 'removed' }, 'match')).toThrow(/removed/);
  });
  it('passes a posted row', () => {
    expect(() => assertFeedPosted({ id: 'tx-3', feed_state: 'posted' }, 'exclude')).not.toThrow();
  });
  it('rejects an unknown feed_state rather than guessing', () => {
    expect(() => feedStateOf({ feed_state: 'weird' })).toThrow(/Unknown feed_state/);
  });
});
