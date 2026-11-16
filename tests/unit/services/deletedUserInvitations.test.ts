/**
 * deletedUserInvitations (follow-up A, rounds 4-5 of #1468): which account a deleted users row owns, and which address
 * its invitation cancel may use. The real-PG cases are in tests/integration/admin-delete-user-invitations-identity.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
const getUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: getUser }));

import { cancelPendingInvitations, ownedGotrueAccount } from '@/modules/admin/services/deletedUserInvitations';

const ID = '0f36a835-cd6c-4291-8afd-726147f2f46f';
const text = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ id: ID, email: 'login@test.local' });
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

describe('cancelPendingInvitations', () => {
  const cancelArgs = () => sqlMock.mock.calls.find((c) => text(c).includes('admin_cancel_user_invitations'))!.slice(1);

  it('with a GoTrue account: its login email only, never the row email (round-5 breaker R5-2)', async () => {
    expect(await cancelPendingInvitations(ID, 'stale-row@test.local', { email: 'login@test.local' })).toBe(3);
    expect(cancelArgs()).toEqual([ID, ['login@test.local']]);
  });

  it('with an account that has no email: no address at all (the pinned arm only)', async () => {
    await cancelPendingInvitations(ID, 'stale-row@test.local', { email: null });
    expect(cancelArgs()).toEqual([ID, []]);
  });

  it('without a GoTrue account: the row email only', async () => {
    await cancelPendingInvitations('legacy-user-1', 'row@test.local', null);
    expect(cancelArgs()).toEqual(['legacy-user-1', ['row@test.local']]);
  });

  it('asks the database nothing else (no survivor rule: a canonical id owns its account, round-5 review)', async () => {
    await cancelPendingInvitations(ID, 'row@test.local', { email: 'login@test.local' });
    expect(sqlMock.mock.calls.map(text).filter((q) => !q.includes('admin_cancel_user_invitations'))).toEqual([]);
  });
});
