/**
 * Unit tests for adminUserActionsService.forceLogout.
 *
 * The bug this guards: an admin "force logout" that only DELETEs from the
 * app-level `user_sessions` table does NOT log the user out, because GoTrue
 * refresh tokens are stateless HS256 JWTs that keep refreshing until GoTrue
 * revokes them. forceLogout MUST call the GoTrue global-revocation for the
 * target userId, and MUST fail closed (surface the error, leave app sessions
 * intact) if that revocation fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn().mockResolvedValue([]);
/** The SQL text of each sqlMock call (a tagged template's strings). */
const sqlTexts = () => sqlMock.mock.calls.map((c) => (c[0] as string[]).join('?'));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));

const adminRevokeAllUserSessions = vi.fn();
vi.mock('@/lib/auth/gotrue', () => ({
  adminRevokeAllUserSessions: (...a: unknown[]) => adminRevokeAllUserSessions(...a),
}));

// generateLink is imported at module load by the service (resetPassword) — stub it.
vi.mock('@/lib/auth/gotrue-admin-link', () => ({ generateLink: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { forceLogout } from '@/modules/admin/services/adminUserActionsService';

const USER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

describe('forceLogout — GoTrue token revocation + app session clear', () => {
  beforeEach(() => {
    // The first statement is the users-row lock (the user exists); the rest answer nothing.
    sqlMock.mockReset().mockResolvedValue([]).mockResolvedValueOnce([{ role: 'viewer' }]);
    adminRevokeAllUserSessions.mockReset().mockResolvedValue(undefined);
  });

  it('revokes the target user\'s GoTrue refresh tokens, then clears app sessions', async () => {
    await forceLogout(USER_ID);
    expect(adminRevokeAllUserSessions).toHaveBeenCalledTimes(1);
    expect(adminRevokeAllUserSessions).toHaveBeenCalledWith(USER_ID);
    // App-level user_sessions still deleted (belt-and-braces), after the users-row lock.
    expect(sqlTexts().map((t) => t.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual(['SELECT role FROM', 'DELETE FROM user_sessions']);
  });

  it('fails closed: if GoTrue revocation throws, forceLogout throws and does NOT delete app sessions', async () => {
    adminRevokeAllUserSessions.mockRejectedValueOnce(new Error('gotrue logout failed: 500'));
    await expect(forceLogout(USER_ID)).rejects.toThrow('gotrue logout failed: 500');
    // Fail-closed ordering: revocation runs before the DELETE, so the DELETE never fires.
    expect(sqlTexts().filter((t) => /DELETE/.test(t))).toEqual([]);
  });

  it('a user that does not exist: 404 before GoTrue is called (review #1405 round 3)', async () => {
    sqlMock.mockReset().mockResolvedValue([]);
    await expect(forceLogout(USER_ID)).rejects.toMatchObject({ status: 404 });
    expect(adminRevokeAllUserSessions).not.toHaveBeenCalled();
  });
});
