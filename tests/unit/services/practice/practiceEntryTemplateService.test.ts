import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  listEntryTemplates,
  getEntryTemplate,
  createEntryTemplate,
  updateEntryTemplate,
  deleteEntryTemplate,
} from '@/modules/accounting/services/practice/practiceEntryTemplateService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const TEMPLATE_ID = 'cccccccc-0000-0000-0000-000000000003';
const CLIENT_ID = 'dddddddd-0000-0000-0000-000000000004';
const CATEGORY_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const WORK_ITEM_ID = 'ffffffff-0000-0000-0000-000000000006';

const templateRow = {
  id: TEMPLATE_ID,
  company_id: COMPANY,
  user_id: USER_ID,
  name: 'SARS Tax Return',
  practice_client_id: CLIENT_ID,
  job_category_id: CATEGORY_ID,
  work_item_id: WORK_ITEM_ID,
  default_hours: '2.50',
  task_description: 'Annual tax return preparation',
  notes: 'Requires prior year return',
  billable: true,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

beforeEach(() => vi.clearAllMocks());

describe('listEntryTemplates', () => {
  it('returns mapped templates for company + user', async () => {
    sqlMock.mockResolvedValueOnce([templateRow]);
    const result = await listEntryTemplates(COMPANY, USER_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('SARS Tax Return');
    expect(result[0]!.companyId).toBe(COMPANY);
    expect(result[0]!.userId).toBe(USER_ID);
    expect(result[0]!.defaultHours).toBe(2.5);
    expect(result[0]!.billable).toBe(true);
  });

  it('returns empty array when no templates exist', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await listEntryTemplates(COMPANY, USER_ID);
    expect(result).toHaveLength(0);
  });
});

describe('getEntryTemplate', () => {
  it('returns null when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await getEntryTemplate(COMPANY, TEMPLATE_ID);
    expect(result).toBeNull();
  });

  it('returns mapped template when found', async () => {
    sqlMock.mockResolvedValueOnce([templateRow]);
    const result = await getEntryTemplate(COMPANY, TEMPLATE_ID);
    expect(result?.id).toBe(TEMPLATE_ID);
    expect(result?.practiceClientId).toBe(CLIENT_ID);
    expect(result?.jobCategoryId).toBe(CATEGORY_ID);
    expect(result?.workItemId).toBe(WORK_ITEM_ID);
    expect(result?.taskDescription).toBe('Annual tax return preparation');
  });
});

describe('createEntryTemplate', () => {
  it('rejects empty name', async () => {
    await expect(
      createEntryTemplate(COMPANY, USER_ID, { name: '   ' })
    ).rejects.toThrow('template name is required');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('rejects completely empty name string', async () => {
    await expect(
      createEntryTemplate(COMPANY, USER_ID, { name: '' })
    ).rejects.toThrow('template name is required');
  });

  it('creates and returns mapped template (happy path)', async () => {
    sqlMock.mockResolvedValueOnce([templateRow]);
    const result = await createEntryTemplate(COMPANY, USER_ID, {
      name: 'SARS Tax Return',
      practiceClientId: CLIENT_ID,
      jobCategoryId: CATEGORY_ID,
      workItemId: WORK_ITEM_ID,
      defaultHours: 2.5,
      taskDescription: 'Annual tax return preparation',
      notes: 'Requires prior year return',
      billable: true,
    });
    expect(result.id).toBe(TEMPLATE_ID);
    expect(result.name).toBe('SARS Tax Return');
    expect(result.defaultHours).toBe(2.5);
  });

  it('defaults billable to true when not provided', async () => {
    sqlMock.mockResolvedValueOnce([{ ...templateRow, billable: true }]);
    const result = await createEntryTemplate(COMPANY, USER_ID, { name: 'Minimal' });
    expect(result.billable).toBe(true);
  });
});

describe('updateEntryTemplate', () => {
  it('throws on not-found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(
      updateEntryTemplate(COMPANY, TEMPLATE_ID, { name: 'New Name' })
    ).rejects.toThrow('not found');
  });

  it('throws on empty name when name is provided', async () => {
    sqlMock.mockResolvedValueOnce([templateRow]);
    await expect(
      updateEntryTemplate(COMPANY, TEMPLATE_ID, { name: '' })
    ).rejects.toThrow('template name is required');
  });

  it('updates and returns modified template (happy path)', async () => {
    const updated = { ...templateRow, name: 'VAT Return', updated_at: new Date() };
    sqlMock.mockResolvedValueOnce([templateRow]).mockResolvedValueOnce([updated]);
    const result = await updateEntryTemplate(COMPANY, TEMPLATE_ID, { name: 'VAT Return' });
    expect(result.name).toBe('VAT Return');
  });
});

describe('deleteEntryTemplate', () => {
  it('deletes without error (happy path)', async () => {
    sqlMock.mockResolvedValueOnce([{ id: TEMPLATE_ID }]);
    await expect(deleteEntryTemplate(COMPANY, TEMPLATE_ID)).resolves.toBeUndefined();
  });

  it('throws when template not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(deleteEntryTemplate(COMPANY, TEMPLATE_ID)).rejects.toThrow('not found');
  });
});
