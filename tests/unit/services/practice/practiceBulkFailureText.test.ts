/**
 * Bulk fill-from-template: which failures are per-date. A refusal keeps its own
 * message; a data error on one row (SQLSTATE class 22/23) is reported with a
 * fixed sentence — its text can name tables and constraints — and logged at
 * warn. Everything else (a statement timeout, an aborted transaction, a lost
 * connection, a non-Error throw) is a server fault and must propagate, so the
 * route 500s and the request rolls back instead of answering a quiet 201.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { log } from '@/lib/logger';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT = 'dddddddd-0000-0000-0000-000000000004';
const CATEGORY = 'eeeeeeee-0000-0000-0000-000000000005';
const WORK_ITEM = 'ffffffff-0000-0000-0000-000000000006';

const TEMPLATE = {
  id: 't', companyId: COMPANY, userId: USER, name: 'T', practiceClientId: CLIENT, jobCategoryId: CATEGORY,
  workItemId: WORK_ITEM, defaultHours: 1, taskDescription: 'Work', notes: null, billable: true, createdAt: '', updatedAt: '',
};
const pgError = (message: string, code: string) => Object.assign(new Error(message), { code });
/** One date's three validation reads and its rate, all passing. */
const readsPass = () => {
  sqlMock.mockResolvedValueOnce([{ id: CLIENT }]).mockResolvedValueOnce([{ id: CATEGORY }]).mockResolvedValueOnce([{ id: WORK_ITEM }]);
  resolveRateMock.mockResolvedValueOnce(850);
};
const run = () => bulkCreateFromTemplate(COMPANY, USER, { templateId: 't', dateFrom: '2026-04-13', dateTo: '2026-04-15' });

beforeEach(() => {
  sqlMock.mockReset(); resolveRateMock.mockReset(); getEntryTemplateMock.mockReset();
  vi.mocked(log.warn).mockClear();
  getEntryTemplateMock.mockResolvedValueOnce(TEMPLATE);
});

describe('bulkCreateFromTemplate per-date failures', () => {
  it('keeps a refusal\'s message and replaces a data error\'s text with the fixed sentence, logging each at warn', async () => {
    // Mon 2026-04-13: the three reads pass, the INSERT fails as Postgres would.
    readsPass();
    sqlMock.mockRejectedValueOnce(pgError('duplicate key value violates unique constraint "time_entries_pkey"', '23505'));
    // Tue 2026-04-14: the client read finds nothing — the service's own refusal.
    sqlMock.mockResolvedValueOnce([]);
    // Wed 2026-04-15: a data exception (22P02) in a read.
    sqlMock.mockRejectedValueOnce(pgError('invalid input syntax for type uuid: "x"', '22P02'));

    const result = await run();
    expect(result.created).toBe(0);
    expect(result.failed).toEqual([
      { date: '2026-04-13', error: 'Could not create this entry' },
      { date: '2026-04-14', error: 'practice client not found or not active' },
      { date: '2026-04-15', error: 'Could not create this entry' },
    ]);
    const warned = vi.mocked(log.warn).mock.calls.map((c) => c[1] as { date: string; code: unknown });
    expect(warned).toEqual([
      expect.objectContaining({ date: '2026-04-13', code: '23505' }),
      expect.objectContaining({ date: '2026-04-14', code: null }),
      expect.objectContaining({ date: '2026-04-15', code: '22P02' }),
    ]);
  });

  it.each([
    ['a statement timeout (57014)', () => pgError('canceling statement due to statement timeout', '57014')],
    ['a deadlock (40P01)', () => pgError('deadlock detected', '40P01')],
    ['a missing column after a deploy (42703)', () => pgError('column "x" does not exist', '42703')],
    ['an aborted transaction (assertTxUsable, no code)', () => new Error('current transaction is aborted, commands ignored until end of transaction block')],
    ['a lost connection (no code)', () => new Error('Connection terminated unexpectedly')],
    ['a thrown non-Error value', () => 'boom'],
  ])('re-throws %s on the second date instead of reporting it', async (_l, fault) => {
    readsPass();
    sqlMock.mockResolvedValueOnce([{ id: 'e1', company_id: COMPANY, user_id: USER, entry_date: '2026-04-13', hours: 1,
      practice_client_id: CLIENT, job_category_id: CATEGORY, work_item_id: WORK_ITEM, task_description: 'Work', billable: true,
      origin: 'recurring', status: 'draft', created_at: '', updated_at: '' }]);
    readsPass();
    sqlMock.mockRejectedValueOnce(fault());
    const thrown = fault();
    await expect(run()).rejects.toEqual(thrown);
  });
});
