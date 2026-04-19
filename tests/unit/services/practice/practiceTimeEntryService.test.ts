import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, resolveRateMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  const resolveRateMock = vi.fn();
  return { sqlMock, resolveRateMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceStaffRateService', () => ({
  resolveRate: resolveRateMock,
}));

import {
  createPracticeEntry,
  updatePracticeEntry,
  deletePracticeEntry,
  getPracticeEntry,
  listPracticeEntries,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';

import {
  duplicatePracticeEntry,
  submitPracticeEntries,
  approvePracticeEntries,
  markEntriesBilled,
} from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const ENTRY_ID = 'cccccccc-0000-0000-0000-000000000003';
const CLIENT = 'dddddddd-0000-0000-0000-000000000004';
const CATEGORY = 'eeeeeeee-0000-0000-0000-000000000005';
const WORK_ITEM = 'ffffffff-0000-0000-0000-000000000006';

const validInput = {
  entryDate: '2026-04-19',
  hours: 2.5,
  practiceClientId: CLIENT,
  jobCategoryId: CATEGORY,
  workItemId: WORK_ITEM,
  taskDescription: 'Monthly management accounts',
};

const activeClientRow = { id: CLIENT, status: 'active' };
const activeCategoryRow = { id: CATEGORY, is_active: true };
const activeWorkItemRow = { id: WORK_ITEM, is_active: true, category_id: CATEGORY };

const entryRow = {
  id: ENTRY_ID,
  company_id: COMPANY,
  user_id: USER,
  entry_date: '2026-04-19',
  hours: 2.5,
  practice_client_id: CLIENT,
  job_category_id: CATEGORY,
  work_item_id: WORK_ITEM,
  task_description: 'Monthly management accounts',
  notes: null,
  billable: true,
  applied_rate: 850,
  line_total: 2125.0,
  origin: 'manual',
  status: 'draft',
  approved_by: null,
  approved_at: null,
  billed_at: null,
  invoice_id: null,
  created_at: new Date('2026-04-19T09:00:00Z'),
  updated_at: new Date('2026-04-19T09:00:00Z'),
};

beforeEach(() => vi.clearAllMocks());

describe('createPracticeEntry', () => {
  it('rejects future date', async () => {
    const futureInput = { ...validInput, entryDate: '2099-01-01' };
    await expect(createPracticeEntry(COMPANY, USER, futureInput))
      .rejects.toThrow(/future/i);
  });

  it('rejects hours = 0', async () => {
    await expect(createPracticeEntry(COMPANY, USER, { ...validInput, hours: 0 }))
      .rejects.toThrow(/hours must be between 0 and 24/);
  });

  it('rejects hours > 24', async () => {
    await expect(createPracticeEntry(COMPANY, USER, { ...validInput, hours: 25 }))
      .rejects.toThrow(/hours must be between 0 and 24/);
  });

  it('rejects inactive client', async () => {
    sqlMock.mockResolvedValueOnce([]); // client lookup returns empty
    await expect(createPracticeEntry(COMPANY, USER, validInput))
      .rejects.toThrow(/practice client not found or not active/);
  });

  it('rejects inactive category', async () => {
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([]); // category lookup empty
    await expect(createPracticeEntry(COMPANY, USER, validInput))
      .rejects.toThrow(/job category not found or not active/);
  });

  it('rejects work item from different category', async () => {
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([activeCategoryRow])
      .mockResolvedValueOnce([]); // work item lookup empty (category_id mismatch)
    await expect(createPracticeEntry(COMPANY, USER, validInput))
      .rejects.toThrow(/work item/i);
  });

  it('resolves rate and computes line_total', async () => {
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([activeCategoryRow])
      .mockResolvedValueOnce([activeWorkItemRow]);
    resolveRateMock.mockResolvedValueOnce(850);
    sqlMock.mockResolvedValueOnce([entryRow]); // INSERT RETURNING

    const result = await createPracticeEntry(COMPANY, USER, validInput);

    expect(resolveRateMock).toHaveBeenCalledWith(COMPANY, USER, CLIENT, '2026-04-19');
    expect(result.appliedRate).toBe(850);
    expect(result.lineTotal).toBe(2125); // 2.5 * 850
    expect(result.origin).toBe('manual');
    expect(result.status).toBe('draft');
  });

  it('allows null rate (no override, no staff default) — line_total null, billable preserved', async () => {
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([activeCategoryRow])
      .mockResolvedValueOnce([activeWorkItemRow]);
    resolveRateMock.mockResolvedValueOnce(null);
    sqlMock.mockResolvedValueOnce([{ ...entryRow, applied_rate: null, line_total: null }]);

    const result = await createPracticeEntry(COMPANY, USER, validInput);
    expect(result.appliedRate).toBeNull();
    expect(result.lineTotal).toBeNull();
  });
});

describe('updatePracticeEntry', () => {
  it('rejects update when entry not draft', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'approved' }]);
    await expect(updatePracticeEntry(COMPANY, ENTRY_ID, { hours: 3 }))
      .rejects.toThrow(/only draft entries/i);
  });

  it('re-resolves rate when hours or date changes', async () => {
    sqlMock.mockResolvedValueOnce([{
      status: 'draft',
      practice_client_id: CLIENT,
      entry_date: '2026-04-19',
      user_id: USER,
      hours: 2,
      job_category_id: CATEGORY,
      work_item_id: WORK_ITEM,
    }]);
    resolveRateMock.mockResolvedValueOnce(900);
    sqlMock.mockResolvedValueOnce([{ ...entryRow, hours: 3, applied_rate: 900, line_total: 2700 }]);

    const result = await updatePracticeEntry(COMPANY, ENTRY_ID, { hours: 3 });
    expect(result.lineTotal).toBe(2700);
  });

  it('update rejects future date', async () => {
    sqlMock.mockResolvedValueOnce([{
      status: 'draft', practice_client_id: CLIENT,
      entry_date: '2026-04-19', user_id: USER, hours: 2,
      job_category_id: CATEGORY, work_item_id: WORK_ITEM,
    }]);
    await expect(updatePracticeEntry(COMPANY, ENTRY_ID, { entryDate: '2099-01-01' }))
      .rejects.toThrow(/future/i);
  });

  it('update rejects hours > 24', async () => {
    sqlMock.mockResolvedValueOnce([{
      status: 'draft', practice_client_id: CLIENT,
      entry_date: '2026-04-19', user_id: USER, hours: 2,
      job_category_id: CATEGORY, work_item_id: WORK_ITEM,
    }]);
    await expect(updatePracticeEntry(COMPANY, ENTRY_ID, { hours: 25 }))
      .rejects.toThrow(/hours must be between 0 and 24/);
  });

  it('update rejects changing to inactive client', async () => {
    sqlMock.mockResolvedValueOnce([{
      status: 'draft', practice_client_id: CLIENT,
      entry_date: '2026-04-19', user_id: USER, hours: 2,
      job_category_id: CATEGORY, work_item_id: WORK_ITEM,
    }]);
    sqlMock.mockResolvedValueOnce([]); // client lookup empty
    await expect(updatePracticeEntry(COMPANY, ENTRY_ID, { practiceClientId: 'other-client' }))
      .rejects.toThrow(/practice client not found or not active/);
  });

  it('update with only notes change preserves line_total', async () => {
    sqlMock.mockResolvedValueOnce([{
      status: 'draft', practice_client_id: CLIENT,
      entry_date: '2026-04-19', user_id: USER, hours: 2.5,
      job_category_id: CATEGORY, work_item_id: WORK_ITEM,
    }]);
    // No validation call for active status because clientId/categoryId/workItemId untouched
    resolveRateMock.mockResolvedValueOnce(850);
    sqlMock.mockResolvedValueOnce([{ ...entryRow, notes: 'updated', applied_rate: 850, line_total: 2125, hours: 2.5 }]);

    const result = await updatePracticeEntry(COMPANY, ENTRY_ID, { notes: 'updated' });
    expect(result.lineTotal).toBe(2125);
    expect(result.hours).toBe(2.5);
  });
});

describe('deletePracticeEntry', () => {
  it('rejects delete when entry not draft', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'submitted' }]);
    await expect(deletePracticeEntry(COMPANY, ENTRY_ID))
      .rejects.toThrow(/only draft entries/i);
  });

  it('deletes draft entry', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'draft' }]);
    sqlMock.mockResolvedValueOnce([]);
    await expect(deletePracticeEntry(COMPANY, ENTRY_ID)).resolves.toBeUndefined();
  });
});

describe('listPracticeEntries', () => {
  it('returns mapped entries with count', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]).mockResolvedValueOnce([entryRow]);
    const result = await listPracticeEntries(COMPANY, { userId: USER });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.id).toBe(ENTRY_ID);
  });
});

describe('duplicatePracticeEntry', () => {
  it('copies an entry to a new date with draft status and origin=recurring', async () => {
    sqlMock.mockResolvedValueOnce([entryRow]); // source lookup
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([activeCategoryRow])
      .mockResolvedValueOnce([activeWorkItemRow]);
    resolveRateMock.mockResolvedValueOnce(850);
    sqlMock.mockResolvedValueOnce([{
      ...entryRow,
      id: 'new-id',
      entry_date: '2026-04-20',
      origin: 'recurring',
      status: 'draft',
    }]);

    const result = await duplicatePracticeEntry(COMPANY, ENTRY_ID, '2026-04-20');
    expect(result.origin).toBe('recurring');
    expect(result.status).toBe('draft');
    expect(result.entryDate).toBe('2026-04-20');
  });
});

describe('submitPracticeEntries', () => {
  it('returns count of rows moved draft → submitted', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const count = await submitPracticeEntries(COMPANY, ['a', 'b']);
    expect(count).toBe(2);
  });

  it('returns 0 for empty ids', async () => {
    const count = await submitPracticeEntries(COMPANY, []);
    expect(count).toBe(0);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('approvePracticeEntries', () => {
  it('stamps approved_by + approved_at; returns count', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'a' }]);
    const count = await approvePracticeEntries(COMPANY, ['a'], USER);
    expect(count).toBe(1);
    // Verify the UPDATE includes approved_by = USER
    const call = sqlMock.mock.calls[0]!;
    const values = call.slice(1);
    expect(values).toContain(USER);
  });
});

describe('markEntriesBilled', () => {
  it('moves approved → billed and stamps invoice_id + billed_at', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const count = await markEntriesBilled(COMPANY, ['a', 'b'], 'inv-1');
    expect(count).toBe(2);
  });
});
