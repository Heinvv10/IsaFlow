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
vi.mock('@/lib/auth/gotrue', () => ({ adminRevokeAllUserSessions: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  deleteUser, resetOnboarding, SoleOwnerError, ONLY_OWNER_MESSAGE,
} from '@/modules/admin/services/adminUserActionsService';

const USER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const text = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');

beforeEach(() => {
  sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('SELECT role FROM users')) return [{ role: 'viewer' }];
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
      if (q.includes('SELECT role FROM users')) return [{ role: 'viewer' }];
      if (q.includes('DELETE FROM company_users')) throw Object.assign(new Error('deadlock'), { code: '40P01' });
      return [];
    });
    const err = await deleteUser(USER).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SoleOwnerError);
    expect((err as { code?: string }).code).toBe('40P01');
  });
});
