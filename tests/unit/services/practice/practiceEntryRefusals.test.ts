/**
 * Every refusal create and bulk raise is a PracticeEntryRefusal — the CLASS is
 * load-bearing, not just the message. Bulk keeps a per-date refusal as that
 * date's failure (anything else is re-thrown → 500 → the whole range rolls
 * back), and the bulk route answers a template/range refusal with 400 (anything
 * else is a 500). A site changed back to `new Error(...)` keeps its message, so
 * `toThrow(/message/)` alone would stay green.
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

import { createPracticeEntry, updatePracticeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { bulkCreateFromTemplate } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';
import { PracticeEntryRefusal } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT = 'dddddddd-0000-0000-0000-000000000004';
const CATEGORY = 'eeeeeeee-0000-0000-0000-000000000005';
const WORK_ITEM = 'ffffffff-0000-0000-0000-000000000006';
const input = {
  entryDate: '2026-04-13', hours: 1, practiceClientId: CLIENT, jobCategoryId: CATEGORY, workItemId: WORK_ITEM, taskDescription: 'Work',
};
const TEMPLATE = {
  id: 't', companyId: COMPANY, userId: USER, name: 'T', practiceClientId: CLIENT, jobCategoryId: CATEGORY,
  workItemId: WORK_ITEM, defaultHours: 1, taskDescription: 'Work', notes: null, billable: true, createdAt: '', updatedAt: '',
};

async function refusal(p: Promise<unknown>, message: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PracticeEntryRefusal);
  expect((err as Error).message).toMatch(message);
}

beforeEach(() => { sqlMock.mockReset(); resolveRateMock.mockReset(); getEntryTemplateMock.mockReset(); });

describe('createPracticeEntry refusals are PracticeEntryRefusal', () => {
  it('a future date', async () => {
    await refusal(createPracticeEntry(COMPANY, USER, { ...input, entryDate: '2999-01-01' }), /entry date cannot be in the future/);
  });

  it.each(['10000-01-05', '2026-02-31', '2026-13-01', '0000-01-01', 'abc', '', 20260105, null])(
    'an entry date that is not a real date: %s', async (entryDate) => {
      await refusal(createPracticeEntry(COMPANY, USER, { ...input, entryDate: entryDate as string }),
        /entry date must be a real date \(YYYY-MM-DD\)/);
      expect(sqlMock).not.toHaveBeenCalled();
    });

  it.each([0, 0.004, 25])('hours %s', async (hours) => {
    await refusal(createPracticeEntry(COMPANY, USER, { ...input, hours }), /hours must be between 0 and 24/);
  });

  it('an inactive or foreign client', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await refusal(createPracticeEntry(COMPANY, USER, input), /practice client not found or not active/);
  });

  it('an inactive or foreign category', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT }]).mockResolvedValueOnce([]);
    await refusal(createPracticeEntry(COMPANY, USER, input), /job category not found or not active/);
  });

  it('a work item that is not the category\'s', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT }]).mockResolvedValueOnce([{ id: CATEGORY }]).mockResolvedValueOnce([]);
    await refusal(createPracticeEntry(COMPANY, USER, input), /work item not found, not active/);
  });
});

describe('bulkCreateFromTemplate refusals are PracticeEntryRefusal', () => {
  const bulk = (over: Record<string, unknown> = {}) =>
    bulkCreateFromTemplate(COMPANY, USER, { templateId: 't', dateFrom: '2026-04-13', dateTo: '2026-04-14', ...over });

  it('a missing template', async () => {
    getEntryTemplateMock.mockResolvedValueOnce(null);
    await refusal(bulk(), /template not found/);
  });

  it('an incomplete template', async () => {
    getEntryTemplateMock.mockResolvedValueOnce({ ...TEMPLATE, workItemId: null });
    await refusal(bulk(), /template is incomplete/);
  });

  it('no hours anywhere', async () => {
    getEntryTemplateMock.mockResolvedValueOnce({ ...TEMPLATE, defaultHours: null });
    await refusal(bulk(), /hours required/);
  });

  it('an inverted range', async () => {
    getEntryTemplateMock.mockResolvedValueOnce(TEMPLATE);
    await refusal(bulk({ dateFrom: '2026-04-14', dateTo: '2026-04-13' }), /dateFrom must be on or before dateTo/);
  });

  it('a range over 62 days', async () => {
    getEntryTemplateMock.mockResolvedValueOnce(TEMPLATE);
    await refusal(bulk({ dateFrom: '2026-01-01', dateTo: '2026-12-31' }), /bulk range too large/);
  });
});

describe('updatePracticeEntry refuses an entry date that is not a real date', () => {
  it.each(['10000-01-05', '2026-02-31'])('%s', async (entryDate) => {
    sqlMock.mockResolvedValueOnce([{ status: 'draft', practice_client_id: CLIENT, entry_date: '2026-04-13', user_id: USER,
      hours: 1, job_category_id: CATEGORY, work_item_id: WORK_ITEM, job_id: null }]);
    await refusal(updatePracticeEntry(COMPANY, 'e1', { entryDate }), /entry date must be a real date/);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
