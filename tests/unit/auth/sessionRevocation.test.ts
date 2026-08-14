import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the GoTrue client so we can assert the exact /logout scope each helper uses.
const signIn = vi.fn();
const logout = vi.fn();
vi.mock('@/lib/auth/gotrue', () => ({
  signIn: (...args: unknown[]) => signIn(...args),
  logout: (...args: unknown[]) => logout(...args),
}));

import { rotateSessionRevokingOthers, revokeAllSessions } from '@/lib/auth/sessionRevocation';

const FRESH = { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 };

describe('sessionRevocation — GoTrue /logout scope mapping', () => {
  beforeEach(() => {
    signIn.mockReset().mockResolvedValue(FRESH);
    logout.mockReset().mockResolvedValue(undefined);
  });

  it('password CHANGE revokes OTHERS (keeps the caller session) and returns the fresh tokens', async () => {
    const result = await rotateSessionRevokingOthers('user@example.com', 'new-password');
    expect(signIn).toHaveBeenCalledWith('user@example.com', 'new-password');
    // Must revoke with scope 'others' using the freshly-minted access token — NOT 'global'
    // (global would kill the caller's own new session) and NOT 'local'.
    expect(logout).toHaveBeenCalledWith('fresh-access', 'others');
    expect(result).toBe(FRESH);
  });

  it('password RESET revokes GLOBALLY (no caller session to preserve)', async () => {
    await revokeAllSessions('user@example.com', 'new-password');
    expect(signIn).toHaveBeenCalledWith('user@example.com', 'new-password');
    expect(logout).toHaveBeenCalledWith('fresh-access', 'global');
  });

  it('propagates a revocation failure so callers fail closed (never a false "secured")', async () => {
    logout.mockRejectedValueOnce(new Error('gotrue down'));
    await expect(rotateSessionRevokingOthers('user@example.com', 'pw')).rejects.toThrow('gotrue down');
  });
});
