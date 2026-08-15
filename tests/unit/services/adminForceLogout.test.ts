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
    sqlMock.mockReset().mockResolvedValue([]);
    adminRevokeAllUserSessions.mockReset().mockResolvedValue(undefined);
  });

  it('revokes the target user\'s GoTrue refresh tokens, then clears app sessions', async () => {
    await forceLogout(USER_ID);
    expect(adminRevokeAllUserSessions).toHaveBeenCalledTimes(1);
    expect(adminRevokeAllUserSessions).toHaveBeenCalledWith(USER_ID);
    // App-level user_sessions still deleted (belt-and-braces).
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed: if GoTrue revocation throws, forceLogout throws and does NOT delete app sessions', async () => {
    adminRevokeAllUserSessions.mockRejectedValueOnce(new Error('gotrue logout failed: 500'));
    await expect(forceLogout(USER_ID)).rejects.toThrow('gotrue logout failed: 500');
    // Fail-closed ordering: revocation runs before the DELETE, so the DELETE never fires.
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
