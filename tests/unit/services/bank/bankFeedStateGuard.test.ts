import { describe, expect, it } from 'vitest';
import {
  assertFeedPosted, BankTransactionNotPostedError, feedStateOf, isBankTransactionNotPosted,
} from '@/modules/accounting/services/bank/bankFeedStateGuard';

describe('bankFeedStateGuard', () => {
  it('throws on a row without feed_state — the column is NOT NULL, so a missing key is a narrowed SELECT (A-13)', () => {
    expect(() => feedStateOf({})).toThrow(/feed_state/);
    expect(() => feedStateOf({ feed_state: undefined })).toThrow(/feed_state/);
    expect(() => feedStateOf({ feed_state: null })).toThrow(/feed_state/);
    expect(() => assertFeedPosted({ id: 'tx-0' }, 'allocate')).toThrow(/feed_state/);
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
