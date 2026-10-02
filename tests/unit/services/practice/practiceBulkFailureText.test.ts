/**
 * Bulk fill-from-template: which failures are per-date. Only a refusal (the
 * job fence, PracticeEntryRefusal) is that date's failure, reported with its
 * message and logged at warn. Every database error — even a class 22/23 one,
 * none of which valid input can reach on this INSERT — and every other throw
 * (an aborted transaction, a lost connection, a non-Error value) is a fault
 * and must propagate, so the route 500s and the request rolls back instead of
 * answering a quiet 201.
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
const inserted = (date: string) => ({ id: `e-${date}`, company_id: COMPANY, user_id: USER, entry_date: date, hours: 1,
  practice_client_id: CLIENT, job_category_id: CATEGORY, work_item_id: WORK_ITEM, task_description: 'Work', billable: true,
  origin: 'recurring', status: 'draft', created_at: '', updated_at: '' });
const run = () => bulkCreateFromTemplate(COMPANY, USER, { templateId: 't', dateFrom: '2026-04-13', dateTo: '2026-04-15' });

beforeEach(() => {
  sqlMock.mockReset(); resolveRateMock.mockReset(); getEntryTemplateMock.mockReset();
  vi.mocked(log.warn).mockClear();
  getEntryTemplateMock.mockResolvedValueOnce(TEMPLATE);
});

describe('bulkCreateFromTemplate per-date failures', () => {
  it('a refusal is that date\'s failure with its message, logged at warn; the other dates are written', async () => {
    readsPass();
    sqlMock.mockResolvedValueOnce([inserted('2026-04-13')]);
    sqlMock.mockResolvedValueOnce([]); // 2026-04-14: the client read finds nothing — the service's refusal
    readsPass();
    sqlMock.mockResolvedValueOnce([inserted('2026-04-15')]);

    const result = await run();
    expect(result.created).toBe(2);
    expect(result.failed).toEqual([{ date: '2026-04-14', error: 'practice client not found or not active' }]);
    expect(vi.mocked(log.warn).mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({ date: '2026-04-14', error: 'practice client not found or not active' }),
    ]);
  });

  it.each([
    ['a unique violation (23505)', () => pgError('duplicate key value violates unique constraint "time_entries_pkey"', '23505')],
    ['a check violation (23514)', () => pgError('new row violates check constraint', '23514')],
    ['a NOT NULL column a deploy added (23502)', () => pgError('null value in column "x" violates not-null constraint', '23502')],
    ['an FK violation that is not 851\'s (23503)', () => pgError('insert or update violates foreign key constraint "y"', '23503')],
    ['bad input syntax, a code bug (22P02)', () => pgError('invalid input syntax for type uuid: "null"', '22P02')],
    ['a statement timeout (57014)', () => pgError('canceling statement due to statement timeout', '57014')],
    ['a deadlock (40P01)', () => pgError('deadlock detected', '40P01')],
    ['a missing column after a deploy (42703)', () => pgError('column "x" does not exist', '42703')],
    ['an aborted transaction (assertTxUsable, no code)', () => new Error('current transaction is aborted, commands ignored until end of transaction block')],
    ['a lost connection (no code)', () => new Error('Connection terminated unexpectedly')],
    ['a thrown non-Error value', () => 'boom'],
  ])('re-throws %s on the second date instead of reporting it', async (_l, fault) => {
    readsPass();
    sqlMock.mockResolvedValueOnce([inserted('2026-04-13')]);
    readsPass();
    sqlMock.mockRejectedValueOnce(fault());
    await expect(run()).rejects.toEqual(fault());
    expect(log.warn).not.toHaveBeenCalled();
  });
});
