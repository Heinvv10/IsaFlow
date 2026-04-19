import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, resolveRateMock, getEntryTemplateMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  const resolveRateMock = vi.fn();
  const getEntryTemplateMock = vi.fn();
  return { sqlMock, resolveRateMock, getEntryTemplateMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceStaffRateService', () => ({
  resolveRate: resolveRateMock,
}));
vi.mock('@/modules/accounting/services/practice/practiceEntryTemplateService', () => ({
  getEntryTemplate: getEntryTemplateMock,
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
  writeOffEntries,
  bulkCreateFromTemplate,
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

beforeEach(() => {
  vi.clearAllMocks();
});

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
  it('update allows clearing notes by passing null', async () => {
    sqlMock.mockResolvedValueOnce([{
      status: 'draft',
      practice_client_id: CLIENT,
      entry_date: '2026-04-19',
      user_id: USER,
      hours: 2.5,
      job_category_id: CATEGORY,
      work_item_id: WORK_ITEM,
    }]);
    resolveRateMock.mockResolvedValueOnce(850);
    sqlMock.mockResolvedValueOnce([{ ...entryRow, notes: null }]);

    const result = await updatePracticeEntry(COMPANY, ENTRY_ID, { notes: null });
    expect(result.notes).toBeNull();

    // Verify updateNotes sentinel = true, notesValue = null in the UPDATE SQL args
    const updateCall = sqlMock.mock.calls[1]!;
    const updateValues = updateCall.slice(1);
    expect(updateValues).toContain(true);  // updateNotes sentinel
  });

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
  it('duplicate rejects future date', async () => {
    await expect(duplicatePracticeEntry(COMPANY, ENTRY_ID, '2099-01-01'))
      .rejects.toThrow(/future/i);
  });

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
      entry_date: '2026-04-18',
      origin: 'recurring',
      status: 'draft',
    }]);

    const result = await duplicatePracticeEntry(COMPANY, ENTRY_ID, '2026-04-18');
    expect(result.origin).toBe('recurring');
    expect(result.status).toBe('draft');
    expect(result.entryDate).toBe('2026-04-18');
  });
});

describe('getPracticeEntry', () => {
  it('returns mapped entry with joined names', async () => {
    sqlMock.mockResolvedValueOnce([{
      ...entryRow,
      practice_client_name: 'Acme (Pty) Ltd',
      job_category_name: 'Accounting',
      work_item_name: 'Monthly bookkeeping',
    }]);
    const result = await getPracticeEntry(COMPANY, ENTRY_ID);
    expect(result).not.toBeNull();
    expect(result!.practiceClientName).toBe('Acme (Pty) Ltd');
    expect(result!.jobCategoryName).toBe('Accounting');
    expect(result!.workItemName).toBe('Monthly bookkeeping');
  });

  it('returns null when entry not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await getPracticeEntry(COMPANY, ENTRY_ID);
    expect(result).toBeNull();
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

describe('writeOffEntries', () => {
  it('rejects empty reason', async () => {
    await expect(writeOffEntries(COMPANY, ['a'], USER, '   '))
      .rejects.toThrow(/reason is required/i);
  });

  it('returns 0 for empty ids without hitting DB', async () => {
    const count = await writeOffEntries(COMPANY, [], USER, 'duplicate work');
    expect(count).toBe(0);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('writes off submitted/approved entries with reason + writer stamp', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const count = await writeOffEntries(COMPANY, ['a', 'b'], USER, 'duplicate work');
    expect(count).toBe(2);
    const call = sqlMock.mock.calls[0]!;
    const values = call.slice(1);
    expect(values).toContain('duplicate work');
    expect(values).toContain(USER);
  });
});

describe('bulkCreateFromTemplate', () => {
  const TEMPLATE_ID = 'ttttttt0-0000-0000-0000-000000000009';

  const completeTemplate = {
    id: TEMPLATE_ID,
    companyId: COMPANY,
    userId: USER,
    name: 'Monthly bookkeeping',
    practiceClientId: CLIENT,
    jobCategoryId: CATEGORY,
    workItemId: WORK_ITEM,
    defaultHours: 2,
    taskDescription: 'Bookkeeping',
    notes: null,
    billable: true,
    createdAt: '',
    updatedAt: '',
  };

  it('rejects missing template', async () => {
    getEntryTemplateMock.mockResolvedValueOnce(null);
    await expect(bulkCreateFromTemplate(COMPANY, USER, {
      templateId: TEMPLATE_ID, dateFrom: '2026-04-13', dateTo: '2026-04-17',
    })).rejects.toThrow(/template not found/);
  });

  it('rejects incomplete template (missing practiceClientId)', async () => {
    getEntryTemplateMock.mockResolvedValueOnce({
      ...completeTemplate,
      practiceClientId: null,
    });
    await expect(bulkCreateFromTemplate(COMPANY, USER, {
      templateId: TEMPLATE_ID, dateFrom: '2026-04-13', dateTo: '2026-04-17',
    })).rejects.toThrow(/template is incomplete/);
  });

  it('rejects when hours missing everywhere', async () => {
    getEntryTemplateMock.mockResolvedValueOnce({
      ...completeTemplate,
      defaultHours: null,
      taskDescription: null,
    });
    await expect(bulkCreateFromTemplate(COMPANY, USER, {
      templateId: TEMPLATE_ID, dateFrom: '2026-04-13', dateTo: '2026-04-17',
    })).rejects.toThrow(/hours required/);
  });

  it('rejects inverted date range', async () => {
    getEntryTemplateMock.mockResolvedValueOnce(completeTemplate);
    await expect(bulkCreateFromTemplate(COMPANY, USER, {
      templateId: TEMPLATE_ID, dateFrom: '2026-04-17', dateTo: '2026-04-13',
    })).rejects.toThrow(/dateFrom must be on or before dateTo/);
  });

  it('rejects range larger than 62 days', async () => {
    getEntryTemplateMock.mockResolvedValueOnce(completeTemplate);
    await expect(bulkCreateFromTemplate(COMPANY, USER, {
      templateId: TEMPLATE_ID, dateFrom: '2026-01-01', dateTo: '2026-12-31',
    })).rejects.toThrow(/too large/);
  });

  it('filters weekdays and creates one draft per matching day', async () => {
    // UTC-safe: 2026-04-13 Mon(1), 2026-04-14 Tue(2), 2026-04-15 Wed(3),
    //           2026-04-16 Thu(4), 2026-04-17 Fri(5) — all 5 match default weekday filter
    // Verified: new Date('2026-04-13T00:00:00Z').getUTCDay() === 1
    getEntryTemplateMock.mockResolvedValueOnce(completeTemplate);
    // 4 sql calls per day (client check, category check, work-item check, INSERT) × 5 days
    for (let i = 0; i < 5; i++) {
      sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active' }]);
      sqlMock.mockResolvedValueOnce([{ id: CATEGORY, is_active: true }]);
      sqlMock.mockResolvedValueOnce([{ id: WORK_ITEM, is_active: true, category_id: CATEGORY }]);
      resolveRateMock.mockResolvedValueOnce(850);
      sqlMock.mockResolvedValueOnce([{
        ...entryRow,
        entry_date: `2026-04-${13 + i}`,
        status: 'draft',
        origin: 'recurring',
      }]);
    }

    const result = await bulkCreateFromTemplate(COMPANY, USER, {
      templateId: TEMPLATE_ID, dateFrom: '2026-04-13', dateTo: '2026-04-17',
    });
    expect(result.created).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('skips weekend days with default Mon-Fri filter', async () => {
    // UTC-safe: 2026-04-18 Sat(6), 2026-04-19 Sun(0) — both filtered by default [1,2,3,4,5]
    // Verified: new Date('2026-04-18T00:00:00Z').getUTCDay() === 6
    //           new Date('2026-04-19T00:00:00Z').getUTCDay() === 0
    getEntryTemplateMock.mockResolvedValueOnce(completeTemplate);
    const result = await bulkCreateFromTemplate(COMPANY, USER, {
      templateId: TEMPLATE_ID, dateFrom: '2026-04-18', dateTo: '2026-04-19',
    });
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
  });
});
