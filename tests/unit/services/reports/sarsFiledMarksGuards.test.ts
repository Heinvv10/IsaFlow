/**
 * markFiled / unmarkFiled refuse a Login-as session before any read or write (R-032 L5, as
 * markSubmitted does).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(() => Promise.resolve([])), { unsafe: vi.fn((s: string) => s) }),
  withSavepoint: vi.fn((_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
class ImpersonationForbiddenError extends Error {}
vi.mock('@/lib/auth/impersonationGuard', () => ({
  assertNotImpersonating: vi.fn(async () => { throw new ImpersonationForbiddenError('Login-as'); }),
}));

import { sql } from '@/lib/neon';
import { markFiled, unmarkFiled } from '@/modules/accounting/services/reports/sarsFiledMarks';

const CO = 'aaaaaaaa-0000-0000-0000-0000000000c1';

describe('a Login-as session is refused before any SQL', () => {
  beforeEach(() => { vi.mocked(sql).mockClear(); });

  it('markFiled', async () => {
    await expect(markFiled(CO, 'u1', { eventType: 'EMP201_DUE', periodEnd: '2026-02-28' })).rejects.toBeInstanceOf(ImpersonationForbiddenError);
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it('unmarkFiled', async () => {
    await expect(unmarkFiled(CO, 'u1', { eventType: 'EMP201_DUE', periodEnd: '2026-02-28' })).rejects.toBeInstanceOf(ImpersonationForbiddenError);
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });
});
