/**
 * D11 round 2 (security LOW): `decideRequest` took the request's row lock BEFORE the impersonation check, so an
 * impersonator waiting behind a held row answered 503 where 403 is due. The session check now runs first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/approvalRequestLock', async (orig) => ({
  ...(await orig<object>()), lockApprovalRequestForUpdate: vi.fn(),
}));

import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { lockApprovalRequestForUpdate, ApprovalRequestLockTimeoutError } from '@/modules/accounting/services/gl/approvalRequestLock';
import { decideRequest } from '@/modules/accounting/services/gl/approvalService';

beforeEach(() => { vi.clearAllMocks(); });

describe('decideRequest: the impersonation check runs before the row lock', () => {
  it.each(['impersonation', 'unknown'] as const)('a %s session is refused 403-style WITHOUT taking the lock', async (actor) => {
    vi.mocked(currentSessionActor).mockResolvedValue(actor as never);
    vi.mocked(lockApprovalRequestForUpdate).mockRejectedValue(new ApprovalRequestLockTimeoutError('r'));
    await expect(decideRequest('c', 'r', 'approved', 'u')).rejects.toMatchObject({ code: 'IMPERSONATION_FORBIDDEN' });
    expect(lockApprovalRequestForUpdate).not.toHaveBeenCalled();
  });

  it('a normal session still takes the lock first (a held row is the lock timeout)', async () => {
    vi.mocked(currentSessionActor).mockResolvedValue('self' as never);
    vi.mocked(lockApprovalRequestForUpdate).mockRejectedValue(new ApprovalRequestLockTimeoutError('r'));
    await expect(decideRequest('c', 'r', 'approved', 'u')).rejects.toBeInstanceOf(ApprovalRequestLockTimeoutError);
  });
});
