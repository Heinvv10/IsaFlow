/**
 * deletedUserInvitations (follow-up A, rounds 4-5 of #1468): which account a deleted users row owns, and which
 * addresses its invitation cancel may use. The real-PG cases are in
 * tests/integration/admin-delete-user-invitations-identity.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
const getUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: getUser }));
const byEmail = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/gotrue', () => ({ findUserByEmail: byEmail }));

import {
  cancelPendingInvitations, deletedUserIdentity, ownedGotrueAccount,
} from '@/modules/admin/services/deletedUserInvitations';

const ID = '0f36a835-cd6c-4291-8afd-726147f2f46f';
const OTHER = '11111111-2222-4333-8444-555555555555';
const text = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ id: ID, email: 'login@test.local' });
  byEmail.mockReset().mockResolvedValue(null);
  sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) =>
    (strings.join('?').includes('admin_cancel_user_invitations') ? [{ n: 3 }] : []));
});

describe('ownedGotrueAccount', () => {
  it('only a canonical lower-case UUID owns an account; GoTrue is asked about nothing else', async () => {
    expect(await ownedGotrueAccount(ID)).toEqual({ email: 'login@test.local' });
    expect(await ownedGotrueAccount(ID.toUpperCase())).toBeNull(); // GoTrue would answer the lower-case account
    expect(await ownedGotrueAccount('legacy-user-1')).toBeNull();
    expect(getUser.mock.calls).toEqual([[ID]]);
  });

  it("GoTrue's 404 is no account; an account with '' (phone-only) is an account with no email", async () => {
    getUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ID, email: '' });
    expect(await ownedGotrueAccount(ID)).toBeNull();
    expect(await ownedGotrueAccount(ID)).toEqual({ email: null });
  });

  it('an outage throws (the delete fails closed)', async () => {
    getUser.mockRejectedValueOnce(new Error('gotrue adminGetUser unavailable: 503'));
    await expect(ownedGotrueAccount(ID)).rejects.toThrow(/unavailable/);
  });
});

describe('deletedUserIdentity', () => {
  it("the row's email is the account's own login (any case or padding): no further lookup", async () => {
    expect(await deletedUserIdentity(ID, ' Login@Test.Local ')).toEqual(
      { account: { email: 'login@test.local' }, rowEmail: ' Login@Test.Local ', rowEmailHeldElsewhere: false });
    expect(byEmail).not.toHaveBeenCalled();
  });

  it('a different account holds the row email: held elsewhere; none, or the same account: not', async () => {
    byEmail.mockResolvedValueOnce({ id: OTHER }).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ID });
    expect((await deletedUserIdentity(ID, 'stale@test.local')).rowEmailHeldElsewhere).toBe(true);
    expect((await deletedUserIdentity(ID, 'stale@test.local')).rowEmailHeldElsewhere).toBe(false);
    expect((await deletedUserIdentity(ID, 'stale@test.local')).rowEmailHeldElsewhere).toBe(false);
    expect(byEmail.mock.calls).toEqual([['stale@test.local'], ['stale@test.local'], ['stale@test.local']]);
  });

  it('a row that owns no account is not looked up further', async () => {
    expect(await deletedUserIdentity('legacy-user-1', 'row@test.local'))
      .toEqual({ account: null, rowEmail: 'row@test.local', rowEmailHeldElsewhere: false });
    expect(byEmail).not.toHaveBeenCalled();
  });

  it('a failed holder lookup throws (the delete fails closed)', async () => {
    byEmail.mockRejectedValueOnce(new Error('gotrue getUserByEmail failed: 500'));
    await expect(deletedUserIdentity(ID, 'stale@test.local')).rejects.toThrow(/failed/);
  });
});

describe('cancelPendingInvitations', () => {
  const cancelArgs = () => sqlMock.mock.calls.find((c) => text(c).includes('admin_cancel_user_invitations'))!.slice(1);
  const identity = (over: Partial<Parameters<typeof cancelPendingInvitations>[2]> = {}) =>
    ({ account: { email: 'login@test.local' }, rowEmail: 'row@test.local', rowEmailHeldElsewhere: false, ...over });

  it('the GoTrue login email and the row email', async () => {
    expect(await cancelPendingInvitations(ID, 'row@test.local', identity())).toBe(3);
    expect(cancelArgs()).toEqual([ID, ['login@test.local', 'row@test.local']]);
  });

  it('the row email held by another account is left out (round-5 breaker R5-2)', async () => {
    await cancelPendingInvitations(ID, 'row@test.local', identity({ rowEmailHeldElsewhere: true }));
    expect(cancelArgs()).toEqual([ID, ['login@test.local']]);
  });

  it('one address once, however it is spelled; none at all when there is none', async () => {
    await cancelPendingInvitations(ID, 'Login@Test.Local', identity({ rowEmail: 'Login@Test.Local' }));
    expect(cancelArgs()).toEqual([ID, ['login@test.local']]);
    sqlMock.mockClear();
    await cancelPendingInvitations(ID, ' ', identity({ account: { email: null }, rowEmail: ' ' }));
    expect(cancelArgs()).toEqual([ID, []]);
  });

  it('without a GoTrue account: the row email', async () => {
    await cancelPendingInvitations('legacy-user-1', 'row@test.local', identity({ account: null }));
    expect(cancelArgs()).toEqual(['legacy-user-1', ['row@test.local']]);
  });

  it('a delete that returned another email than the one judged throws before cancelling anything', async () => {
    await expect(cancelPendingInvitations(ID, 'changed@test.local', identity())).rejects.toThrow(/email changed/);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
