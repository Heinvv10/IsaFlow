/**
 * Budgets P5-5 review r2: saving a variance note refuses a platform-admin "Login as" session FIRST, as
 * approve and reject do (R-032 L5): nothing is read or written. The guard's own reads are covered by
 * tests/unit/auth/impersonationGuard.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/impersonationGuard')>();
  return { ...real, assertNotImpersonating: async () => { throw new real.ImpersonationForbiddenError(); } };
});

import { saveVarianceNote } from '@/modules/accounting/services/commentary/varianceCommentary';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';

describe('saveVarianceNote under Login-as', () => {
  it('throws IMPERSONATION_FORBIDDEN before any query', async () => {
    const V = '11111111-1111-4111-8111-111111111111';
    await expect(saveVarianceNote(V, { userId: 'u', role: 'owner' }, {
      versionId: V, month: '2026-06', glAccountId: V, cc1Id: null, cc2Id: null, buId: null, text: 'x',
    })).rejects.toBeInstanceOf(ImpersonationForbiddenError);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
