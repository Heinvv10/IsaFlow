/**
 * Unit coverage for the user-account allow-list predicate.
 *
 * `public.users` carries three overlapping signals — is_active (boolean,
 * default true), status (varchar, default 'active', no CHECK constraint) and
 * suspended_at (nullable timestamptz). suspendUser() writes all three
 * (is_active=false + suspended_at=NOW()); nothing in the codebase ever writes
 * `status`, so it is dormant vocabulary that must still be honoured if an
 * operator sets it by hand.
 *
 * The predicate is an ALLOW-list: a row is active only when every signal says
 * so. These tests pin each signal independently so that dropping any one of
 * the three clauses turns a test red.
 */
import { describe, it, expect } from 'vitest';
import { isActiveUserAccount, SUSPENDED_ACCOUNT_ERROR } from '@/lib/auth/userAccountStatus';

const ACTIVE = { is_active: true, status: 'active', suspended_at: null };

describe('isActiveUserAccount', () => {
  it('allows a fully active row', () => {
    expect(isActiveUserAccount(ACTIVE)).toBe(true);
  });

  it('allows a NULL status (column default was never written)', () => {
    expect(isActiveUserAccount({ ...ACTIVE, status: null })).toBe(true);
  });

  it('allows mixed-case status', () => {
    expect(isActiveUserAccount({ ...ACTIVE, status: 'ACTIVE' })).toBe(true);
  });

  it('denies is_active = false', () => {
    expect(isActiveUserAccount({ ...ACTIVE, is_active: false })).toBe(false);
  });

  it('denies is_active = null (deactivated by a partial write)', () => {
    expect(isActiveUserAccount({ ...ACTIVE, is_active: null })).toBe(false);
  });

  it('denies a non-active status even when is_active is still true', () => {
    expect(isActiveUserAccount({ ...ACTIVE, status: 'suspended' })).toBe(false);
    expect(isActiveUserAccount({ ...ACTIVE, status: 'disabled' })).toBe(false);
    expect(isActiveUserAccount({ ...ACTIVE, status: 'pending' })).toBe(false);
  });

  it('denies a set suspended_at even when is_active is still true', () => {
    expect(isActiveUserAccount({ ...ACTIVE, suspended_at: new Date('2026-01-01') })).toBe(false);
    expect(isActiveUserAccount({ ...ACTIVE, suspended_at: '2026-01-01T00:00:00Z' })).toBe(false);
  });

  it('denies a missing row — no profile means no proof of good standing', () => {
    expect(isActiveUserAccount(null)).toBe(false);
    expect(isActiveUserAccount(undefined)).toBe(false);
  });

  it('exposes a stable machine-readable error code', () => {
    expect(SUSPENDED_ACCOUNT_ERROR.code).toBe('ACCOUNT_SUSPENDED');
    expect(SUSPENDED_ACCOUNT_ERROR.message).toMatch(/suspend/i);
  });
});

describe('MISSING_PROFILE_ERROR', () => {
  it('is a distinct code from suspension and never says "suspended"', async () => {
    const { MISSING_PROFILE_ERROR, SUSPENDED_ACCOUNT_ERROR } = await import('@/lib/auth/userAccountStatus');
    expect(MISSING_PROFILE_ERROR.code).toBe('ACCOUNT_PROFILE_MISSING');
    expect(MISSING_PROFILE_ERROR.code).not.toBe(SUSPENDED_ACCOUNT_ERROR.code);
    // The whole point of the split: an operator must not go hunting for a
    // suspension that was never applied.
    expect(MISSING_PROFILE_ERROR.message).not.toMatch(/suspend/i);
  });
});
