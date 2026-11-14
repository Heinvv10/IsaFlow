/**
 * suspendUser must actually close the account, not just flag it.
 *
 * The flag alone is enforced by the auth-layer gates (withAuth,
 * bearerPipeline, withUserAuth, login), but a blocked token is strictly worse
 * than a revoked one: revoked-at-source survives a future code path that
 * forgets to consult the gate. suspendUser therefore revokes every credential
 * it can reach — GoTrue refresh tokens, PATs, and OAuth authorisations.
 *
 * Assertions are behavioural (which revocations fired, in what order relative
 * to the flag, what happens when GoTrue is down) rather than SQL-text matches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...(a as [TemplateStringsArray])) }));

const adminRevokeAllUserSessions = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/auth/gotrue', () => ({
  adminRevokeAllUserSessions: (...a: unknown[]) => adminRevokeAllUserSessions(...a),
}));
vi.mock('@/lib/auth/gotrue-admin-link', () => ({ generateLink: vi.fn() }));

const revokeAllUserPats = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('@/lib/auth/personalAccessTokens', () => ({
  revokeAllUserPats: (...a: unknown[]) => revokeAllUserPats(...a),
}));

const revokeAllUserAuthorisations = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('@/lib/auth/oauth', () => ({
  revokeAllUserAuthorisations: (...a: unknown[]) => revokeAllUserAuthorisations(...a),
}));

const findStranded = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/core/payRunApproverGuard', () => ({ assertPayRunApproverRetainedEverywhere: vi.fn(async () => undefined), findStrandedPayRunRequests: findStranded })); // judged on a real database: payroll-approver-guard-paths.int.test.ts
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { suspendUser } from '@/modules/admin/services/adminUserActionsService';

const USER = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  findStranded.mockResolvedValue([]);
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/UPDATE users/i.test(text)) calls.push('FLAG');
    if (/DELETE FROM user_sessions/i.test(text)) calls.push('LEGACY_SESSIONS');
    return [];
  });
  adminRevokeAllUserSessions.mockImplementation(async () => { calls.push('GOTRUE'); });
  revokeAllUserPats.mockImplementation(async () => { calls.push('PATS'); return 2; });
  revokeAllUserAuthorisations.mockImplementation(async () => { calls.push('OAUTH'); return 3; });
});

describe('suspendUser — credential revocation', () => {
  it('revokes GoTrue sessions, PATs and OAuth authorisations for the user', async () => {
    await suspendUser(USER, 'left the company');

    expect(adminRevokeAllUserSessions).toHaveBeenCalledWith(USER);
    expect(revokeAllUserPats).toHaveBeenCalledWith(USER);
    expect(revokeAllUserAuthorisations).toHaveBeenCalledWith(USER);
  });

  it('sets the suspension flag BEFORE revoking, so the gate is live even if revocation dies', async () => {
    await suspendUser(USER, 'reason');
    expect(calls.indexOf('FLAG')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('FLAG')).toBeLessThan(calls.indexOf('GOTRUE'));
  });

  it('still revokes the DB-side credentials when GoTrue is unreachable, and reports the sessions as not revoked', async () => {
    adminRevokeAllUserSessions.mockRejectedValueOnce(new Error('gotrue unreachable'));

    await expect(suspendUser(USER, 'reason')).resolves.toEqual({ stranded: [], sessionsRevoked: false });

    // The flag landed and the credentials we CAN revoke are revoked. It does not throw (admin audit 2026-11-14,
    // 3.2): the suspension commits with its audit row, which records revocation_failed, and the admin is told
    // live GoTrue sessions may survive to expiry (tests/integration/admin-suspend-reset-2fa-audit.int.test.ts).
    expect(calls).toContain('FLAG');
    expect(revokeAllUserPats).toHaveBeenCalledWith(USER);
    expect(revokeAllUserAuthorisations).toHaveBeenCalledWith(USER);
  });

  it('is never stopped by a failed look-up of the pay-run approvals it strands: it logs, and revokes', async () => {
    findStranded.mockRejectedValueOnce(new Error('migration_admin pool down'));

    await expect(suspendUser(USER, 'compromised')).resolves.toEqual({ stranded: [], sessionsRevoked: true });

    expect(calls).toContain('FLAG');
    expect(revokeAllUserPats).toHaveBeenCalledWith(USER);
  });

  it('returns the pending pay-run approvals it leaves without another approver, for the admin audit row', async () => {
    findStranded.mockResolvedValueOnce([{ companyId: 'c1', requestId: 'r1' }]);

    await expect(suspendUser(USER, 'compromised')).resolves
      .toEqual({ stranded: [{ companyId: 'c1', requestId: 'r1' }], sessionsRevoked: true });
    expect(calls).toContain('FLAG');
  });
});
