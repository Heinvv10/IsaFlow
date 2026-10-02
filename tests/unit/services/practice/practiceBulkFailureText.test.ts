/**
 * Bulk fill-from-template reports each failed date in its 201 body. A service
 * refusal keeps its own message; a database error must not: pg errors carry a
 * SQLSTATE and their text can name tables and constraints, so that date says
 * the fixed sentence instead.
 */
import { describe, it, expect, vi } from 'vitest';

const { sqlMock, resolveRateMock, getEntryTemplateMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(), resolveRateMock: vi.fn(), getEntryTemplateMock: vi.fn(),
}));

vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/practice/practiceStaffRateService', () => ({ resolveRate: resolveRateMock }));
vi.mock('@/modules/accounting/services/practice/practiceEntryTemplateService', () => ({ getEntryTemplate: getEntryTemplateMock }));

import { bulkCreateFromTemplate } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT = 'dddddddd-0000-0000-0000-000000000004';
const CATEGORY = 'eeeeeeee-0000-0000-0000-000000000005';
const WORK_ITEM = 'ffffffff-0000-0000-0000-000000000006';

describe('bulkCreateFromTemplate failure text', () => {
  it('keeps a refusal\'s message and replaces a database error\'s text with the fixed sentence', async () => {
    getEntryTemplateMock.mockResolvedValueOnce({
      id: 't', companyId: COMPANY, userId: USER, name: 'T', practiceClientId: CLIENT, jobCategoryId: CATEGORY,
      workItemId: WORK_ITEM, defaultHours: 1, taskDescription: 'Work', notes: null, billable: true, createdAt: '', updatedAt: '',
    });
    // Mon 2026-04-13: the three reads pass, the INSERT fails as Postgres would.
    sqlMock.mockResolvedValueOnce([{ id: CLIENT }]).mockResolvedValueOnce([{ id: CATEGORY }]).mockResolvedValueOnce([{ id: WORK_ITEM }]);
    resolveRateMock.mockResolvedValueOnce(850);
    sqlMock.mockRejectedValueOnce(Object.assign(
      new Error('duplicate key value violates unique constraint "time_entries_pkey"'), { code: '23505' }));
    // Tue 2026-04-14: the client read finds nothing — the service's own refusal.
    sqlMock.mockResolvedValueOnce([]);

    const result = await bulkCreateFromTemplate(COMPANY, USER, {
      templateId: 't', dateFrom: '2026-04-13', dateTo: '2026-04-14',
    });
    expect(result.created).toBe(0);
    expect(result.failed).toEqual([
      { date: '2026-04-13', error: 'Could not create this entry' },
      { date: '2026-04-14', error: 'practice client not found or not active' },
    ]);
  });
});
