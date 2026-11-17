/**
 * invitationAccountRole (src/lib/auth/inviteAccount.ts): what the anonymous accept may do with the account it
 * resolved. A password is set only on an account nobody has ever signed in to: one an invitation created
 * (invite_id), or one that is not even confirmed (an unconfirmed signup or a squatter at the invited address; the
 * invite link proves the mailbox, and such an account holds nothing). Any account that has signed in, or a
 * confirmed one no invitation created, signs in with its own password (#1517 breaker B3/B4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ adminGetUser: vi.fn() }));
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: h.adminGetUser }));
vi.mock('@/lib/auth/gotrue', () => ({ findUserByEmail: vi.fn(), adminCreateUser: vi.fn() }));

import { invitationAccountRole } from '@/lib/auth/inviteAccount';

const inv = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'v@x.test' };
const SIGNED_IN = '2026-11-01T00:00:00Z';
const role = (account: Record<string, unknown> | null) => {
  h.adminGetUser.mockResolvedValue(account === null ? null : { id: 'x', email: 'v@x.test', ...account });
  return invitationAccountRole(inv, 'x');
};

beforeEach(() => { h.adminGetUser.mockReset(); });

describe('invitationAccountRole', () => {
  it.each([
    ['created by this invitation, never signed in', { user_metadata: { invite_id: inv.id }, email_confirmed_at: SIGNED_IN }, 'set-password'],
    ["another invitation's placeholder, never signed in", { user_metadata: { invite_id: 'other' }, email_confirmed_at: SIGNED_IN }, 'set-password'],
    ['an unconfirmed signup or squatter: never confirmed, never signed in (B4)', { user_metadata: {}, last_sign_in_at: null }, 'set-password'],
    ['created by this invitation but signed in since (B3)', { user_metadata: { invite_id: inv.id }, last_sign_in_at: SIGNED_IN }, 'sign-in'],
    ["another invitation's account, signed in since", { user_metadata: { invite_id: 'other' }, last_sign_in_at: SIGNED_IN }, 'sign-in'],
    ['confirmed, created by no invitation, never signed in', { user_metadata: {}, email_confirmed_at: SIGNED_IN }, 'sign-in'],
    ['created by no invitation, signed in (a deleted user\'s login)', { user_metadata: {}, email_confirmed_at: SIGNED_IN, last_sign_in_at: SIGNED_IN }, 'sign-in'],
    ['unconfirmed but signed in once', { user_metadata: {}, last_sign_in_at: SIGNED_IN }, 'sign-in'],
  ])('%s: %s', async (_, account, expected) => {
    expect(await role(account)).toBe(expected);
  });

  it.each([
    ['GoTrue has no such account', null],
    ["its login email is no longer the invitation's", { email: 'moved@x.test', user_metadata: { invite_id: inv.id } }],
  ])('%s: mismatch', async (_, account) => {
    expect(await role(account as Record<string, unknown> | null)).toBe('mismatch');
  });
});
