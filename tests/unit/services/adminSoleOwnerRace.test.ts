/**
 * Audit S-04/S-08 follow-up A: deleteUser and resetOnboarding remove a user
 * from every company. When the trigger refuses (RC011, a company's only owner)
 * after the service's own check passed — a co-owner removed in between — the
 * refusal is a SoleOwnerError (the routes' 409), and the membership delete is
 * the only write attempted (it runs first). The real-PG cases are in
 * tests/integration/s0408-admin-sole-owner.int.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
const holder = vi.hoisted(() => vi.fn(async () => null as null | { id: string }));
vi.mock('@/lib/auth/gotrue', () => ({ adminRevokeAllUserSessions: vi.fn(), findUserByEmail: holder }));
const gotrueUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: gotrueUser }));
const findStranded = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/core/payRunApproverGuard', () => ({ assertPayRunApproverRetainedEverywhere: vi.fn(async () => undefined), findStrandedPayRunRequests: findStranded })); // judged on a real database: payroll-approver-guard-paths.int.test.ts
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  deleteUser, resetOnboarding, SoleOwnerError, ONLY_OWNER_MESSAGE,
} from '@/modules/admin/services/adminUserActionsService';

const USER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const text = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');

beforeEach(() => {
  findStranded.mockReset().mockResolvedValue([]);
  gotrueUser.mockReset().mockResolvedValue({ id: USER, email: 'login@test.local' });
  holder.mockReset().mockResolvedValue(null);
  sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('SELECT role, email FROM users')) return [{ role: 'viewer', email: 'gone@test.local' }];
    if (q.includes('SELECT 1 FROM users')) return [{ '?column?': 1 }]; // resetOnboarding's existence read
    if (q.includes('DELETE FROM company_users')) throw Object.assign(new Error('only owner'), { code: 'RC011' });
    return [];
  });
});

describe("the trigger's RC011 on a user's memberships", () => {
  it.each([
    ['deleteUser', deleteUser],
    ['resetOnboarding', resetOnboarding],
  ] as const)('%s throws SoleOwnerError and attempts no other write', async (_, act) => {
    const err = await act(USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SoleOwnerError);
    expect((err as Error).message).toBe(ONLY_OWNER_MESSAGE);
    const writes = sqlMock.mock.calls.map(text).filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q));
    expect(writes.map((q) => q.trim().split(' ').slice(0, 3).join(' '))).toEqual(['DELETE FROM company_users']);
  });

  it('any other database error propagates unchanged (a 500 rolls the request back)', async () => {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (q.includes('SELECT role, email FROM users')) return [{ role: 'viewer', email: 'gone@test.local' }];
      if (q.includes('DELETE FROM company_users')) throw Object.assign(new Error('deadlock'), { code: '40P01' });
      return [];
    });
    const err = await deleteUser(USER).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SoleOwnerError);
    expect((err as { code?: string }).code).toBe('40P01');
  });
});

describe('deleteUser is never stopped by the look-up of pay-run approvals it strands', () => {
  it('a failed look-up is logged and the deletion goes ahead, every write made', async () => {
    findStranded.mockRejectedValueOnce(new Error('migration_admin pool down'));
    sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (q.includes('SELECT role, email FROM users')) return [{ role: 'viewer', email: 'gone@test.local' }];
      if (q.includes('DELETE FROM users')) return [{ email: 'gone@test.local' }]; // RETURNING: the row was there
      if (q.includes('admin_cancel_user_invitations')) return [{ n: 2 }];
      return [];
    });
    await expect(deleteUser(USER)).resolves.toEqual({ stranded: [], invitationsCancelled: 2, sentInvitationsUnattributed: [] });
    const writes = sqlMock.mock.calls.map(text).filter((q) => /^\s*(DELETE\b|SELECT public\.admin_cancel)/i.test(q))
      .map((q) => q.trim().split(' ').slice(0, 3).join(' '));
    // company_users -> users -> user_sessions (the one lock order), the sweep of a membership added meanwhile, then
    // the invitations, last (follow-up A), for the address the users DELETE returned.
    expect(writes).toEqual(['DELETE FROM company_users', 'DELETE FROM users', 'DELETE FROM user_sessions', 'DELETE FROM company_users',
      'SELECT public.admin_cancel_user_invitations(?, ?::text[])']);
    // The user's GoTrue id, its GoTrue login email and the row's email, which no other account holds (GoTrue read
    // once each, before any write).
    const cancel = sqlMock.mock.calls.find((c) => text(c).includes('admin_cancel_user_invitations'))!;
    expect(cancel.slice(1)).toEqual([USER, ['login@test.local', 'gone@test.local']]);
    expect(holder.mock.calls).toEqual([['gone@test.local']]);
    expect(holder.mock.invocationCallOrder[0]!).toBeLessThan(
      sqlMock.mock.invocationCallOrder[sqlMock.mock.calls.findIndex((c) => /^\s*DELETE\b/i.test(text(c)))]!);
    expect(gotrueUser.mock.calls).toEqual([[USER]]);
    expect(gotrueUser.mock.invocationCallOrder[0]!).toBeLessThan(
      sqlMock.mock.invocationCallOrder[sqlMock.mock.calls.findIndex((c) => /^\s*DELETE\b/i.test(text(c)))]!);
  });

  it('a GoTrue outage fails the delete before any write (never a partial cancel)', async () => {
    gotrueUser.mockRejectedValueOnce(new Error('gotrue adminGetUser unavailable: 503'));
    sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) =>
      (strings.join('?').includes('SELECT role, email FROM users') ? [{ role: 'viewer', email: 'gone@test.local' }] : []));
    await expect(deleteUser(USER)).rejects.toThrow(/unavailable/);
    expect(sqlMock.mock.calls.map(text).filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b|admin_cancel/i.test(q))).toEqual([]);
  });

  it('returns what it strands, for the admin audit row', async () => {
    findStranded.mockResolvedValueOnce([{ companyId: 'c1', requestId: 'r1' }]);
    sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (q.includes('SELECT role, email FROM users')) return [{ role: 'viewer', email: 'gone@test.local' }];
      return q.includes('DELETE FROM users') ? [{ email: 'gone@test.local' }] : [];
    });
    await expect(deleteUser(USER)).resolves.toEqual({ stranded: [{ companyId: 'c1', requestId: 'r1' }], invitationsCancelled: 0, sentInvitationsUnattributed: [] });
  });

  // 997c: the users DELETE nulls invited_by; the ids are read just before it, for the audit row.
  it('returns the ids of the invitations the user sent, read by the user\'s id before the users DELETE', async () => {
    sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (q.includes('SELECT role, email FROM users')) return [{ role: 'viewer', email: 'gone@test.local' }];
      if (/^SELECT id FROM company_invitations WHERE invited_by = \? ORDER BY id$/.test(q.trim())) return [{ id: 'i1' }];
      return q.includes('DELETE FROM users') ? [{ email: 'gone@test.local' }] : [];
    });
    await expect(deleteUser(USER)).resolves.toEqual({ stranded: [], invitationsCancelled: 0, sentInvitationsUnattributed: ['i1'] });
    const calls = sqlMock.mock.calls.map(text);
    const read = calls.findIndex((q) => q.includes('FROM company_invitations WHERE invited_by'));
    expect(sqlMock.mock.calls[read]!.slice(1)).toEqual([USER]);
    expect(read).toBeLessThan(calls.findIndex((q) => q.trim().startsWith('DELETE FROM users')));
  });
});
