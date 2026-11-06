// Replacing a pack is refused while impersonating, before anything is read or removed (as AFS sign-off is, R-032 L5).
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), assertNotImpersonating: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: vi.fn(), fmtDate: String }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: m.assertNotImpersonating }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/afs/packDeliveryService', () => ({ packEmailSubjectEnd: (p: string) => ` — Management Accounts ${p}` }));

import { removeDraftPack } from '@/modules/accounting/services/afs/managementPackExisting';

describe('removeDraftPack', () => {
  it('runs no query for an impersonator', async () => {
    m.assertNotImpersonating.mockRejectedValue(new Error('impersonating'));
    await expect(removeDraftPack('co', '2026-08', 'u')).rejects.toThrow('impersonating');
    expect(m.sql).not.toHaveBeenCalled();
  });
});
