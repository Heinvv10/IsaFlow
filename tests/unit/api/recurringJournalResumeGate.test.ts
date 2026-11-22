/** #1656 round 4: resuming an AUTO-POSTING recurring journal needs Chart of Accounts & GL Approve (as creating one does, and the MCP resume); a draft-only template, pause and cancel need nothing. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/recurringJournalService', async (orig) => ({
  ...(await orig<object>()),
  getRecurringJournalById: vi.fn(), updateRecurringJournalStatus: vi.fn(async () => ({ changed: true })), runRecurringJournal: vi.fn(),
}));

import { checkPermission } from '@/lib/auth/permissionService';
import { getRecurringJournalById, updateRecurringJournalStatus } from '@/modules/accounting/services/gl/recurringJournalService';
import handler from '../../../pages/api/accounting/recurring-journals-action';

const C = '11111111-1111-4111-8111-111111111111';
const ID = '66666666-6666-4666-8666-666666666666';
function call(action: string) {
  const req = { method: 'POST', query: {}, body: { action, id: ID }, companyId: C, user: { id: 'u-1' } } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; } };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(checkPermission).mockResolvedValue(false); });

describe('recurring-journals-action resume', () => {
  it('an auto-posting template (and one with the flag unset, which posts) is refused 403 without Approve; nothing is changed', async () => {
    for (const autoPost of [true, undefined]) {
      vi.mocked(getRecurringJournalById).mockResolvedValue({ id: ID, autoPost } as never);
      const res = await call('resume');
      expect(res.statusCode, String(autoPost)).toBe(403);
      expect(checkPermission).toHaveBeenCalledWith(C, 'u-1', 'accounts', 'approve');
      expect(updateRecurringJournalStatus).not.toHaveBeenCalled();
    }
  });

  it('a draft-only template resumes without Approve, and pause / cancel never ask', async () => {
    vi.mocked(getRecurringJournalById).mockResolvedValue({ id: ID, autoPost: false } as never);
    expect((await call('resume')).statusCode).toBe(200);
    expect((await call('pause')).statusCode).toBe(200);
    expect((await call('cancel')).statusCode).toBe(200);
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('with Approve an auto-posting template resumes', async () => {
    vi.mocked(checkPermission).mockResolvedValue(true);
    vi.mocked(getRecurringJournalById).mockResolvedValue({ id: ID, autoPost: true } as never);
    expect((await call('resume')).statusCode).toBe(200);
  });
});
