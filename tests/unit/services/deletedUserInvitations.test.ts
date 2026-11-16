/**
 * deletedUserInvitations (follow-up A, round-4 review of #1468): which GoTrue email a deleted user's invitation
 * cancel may use. The real-PG cases are in tests/integration/admin-delete-user-invitations-identity.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
const getUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: getUser }));

import { cancelPendingInvitations, gotrueLoginEmail } from '@/modules/admin/services/deletedUserInvitations';

const ID = '0f36a835-cd6c-4291-8afd-726147f2f46f';
const text = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ id: ID, email: 'login@test.local' });
  sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) =>
    (strings.join('?').includes('admin_cancel_user_invitations') ? [{ n: 3 }] : []));
});

describe('gotrueLoginEmail', () => {
  it('asks GoTrue only for a canonical lower-case UUID', async () => {
    expect(await gotrueLoginEmail(ID)).toBe('login@test.local');
    expect(await gotrueLoginEmail(ID.toUpperCase())).toBeNull(); // GoTrue would answer the lower-case account
    expect(await gotrueLoginEmail('legacy-user-1')).toBeNull();
    expect(getUser.mock.calls).toEqual([[ID]]);
  });

  it("no account, or an account with no email (GoTrue's '' for a phone-only account), is null", async () => {
    getUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ID, email: '' });
    expect(await gotrueLoginEmail(ID)).toBeNull();
    expect(await gotrueLoginEmail(ID)).toBeNull();
  });

  it('an outage throws (the delete fails closed)', async () => {
    getUser.mockRejectedValueOnce(new Error('gotrue adminGetUser unavailable: 503'));
    await expect(gotrueLoginEmail(ID)).rejects.toThrow(/unavailable/);
  });
});

describe('cancelPendingInvitations', () => {
  const cancelArgs = () => sqlMock.mock.calls.find((c) => text(c).includes('admin_cancel_user_invitations'))!.slice(1);

  it('passes the deleted row email and the GoTrue email, once each', async () => {
    expect(await cancelPendingInvitations(ID, 'row@test.local', 'login@test.local')).toBe(3);
    expect(cancelArgs()).toEqual([ID, ['row@test.local', 'login@test.local']]);
  });

  it('passes the GoTrue email whatever other rows exist: a canonical id owns its account (round-5 review)', async () => {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (/FROM users/i.test(q)) return [{ '?column?': 1 }]; // a case variant would be found, were it asked
      return q.includes('admin_cancel_user_invitations') ? [{ n: 1 }] : [];
    });
    expect(await cancelPendingInvitations(ID, 'row@test.local', 'login@test.local')).toBe(1);
    expect(cancelArgs()).toEqual([ID, ['row@test.local', 'login@test.local']]);
    expect(sqlMock.mock.calls.map(text).filter((q) => /FROM users/i.test(q))).toEqual([]);
  });
});
