import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  listJobCategories,
  createJobCategory,
  updateJobCategory,
  deleteJobCategory,
  listWorkItems,
  createWorkItem,
  updateWorkItem,
  seedDefaultCategories,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const CAT_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const ITEM_ID = 'cccccccc-0000-0000-0000-000000000003';

const catRow = {
  id: CAT_ID, company_id: COMPANY, name: 'Payroll',
  sort_order: 1, is_active: true, reporting_tag: 'payroll',
  created_at: new Date(), updated_at: new Date(),
};
const itemRow = {
  id: ITEM_ID, company_id: COMPANY, category_id: CAT_ID,
  name: 'Monthly Processing', sort_order: 1, is_active: true,
  default_billable: true, default_rate_override: null,
  created_at: new Date(), updated_at: new Date(),
};

beforeEach(() => vi.clearAllMocks());

describe('listJobCategories', () => {
  it('returns mapped categories', async () => {
    sqlMock.mockResolvedValueOnce([catRow]);
    const result = await listJobCategories(COMPANY);
    expect(result[0]!.name).toBe('Payroll');
    expect(result[0]!.isActive).toBe(true);
  });
});

describe('createJobCategory', () => {
  it('inserts and returns category', async () => {
    sqlMock.mockResolvedValueOnce([catRow]);
    const result = await createJobCategory(COMPANY, { name: 'Payroll', sortOrder: 1 });
    expect(result.id).toBe(CAT_ID);
  });
});

describe('updateJobCategory', () => {
  it('updates and returns category', async () => {
    const updated = { ...catRow, name: 'Payroll & HR' };
    sqlMock.mockResolvedValueOnce([catRow]).mockResolvedValueOnce([updated]);
    const result = await updateJobCategory(COMPANY, CAT_ID, { name: 'Payroll & HR' });
    expect(result.name).toBe('Payroll & HR');
  });

  it('throws when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(updateJobCategory(COMPANY, CAT_ID, {})).rejects.toThrow('not found');
  });
});

describe('deleteJobCategory', () => {
  it('soft-deletes (sets is_active = false)', async () => {
    sqlMock.mockResolvedValueOnce([catRow]).mockResolvedValueOnce([]);
    await expect(deleteJobCategory(COMPANY, CAT_ID)).resolves.toBeUndefined();
  });
});

describe('listWorkItems', () => {
  it('returns work items for category', async () => {
    sqlMock.mockResolvedValueOnce([itemRow]);
    const result = await listWorkItems(COMPANY, CAT_ID);
    expect(result[0]!.name).toBe('Monthly Processing');
    expect(result[0]!.defaultBillable).toBe(true);
  });

  it('returns all active work items when no categoryId given', async () => {
    sqlMock.mockResolvedValueOnce([itemRow]);
    const result = await listWorkItems(COMPANY);
    expect(result).toHaveLength(1);
  });
});

describe('createWorkItem', () => {
  it('inserts and returns work item', async () => {
    sqlMock.mockResolvedValueOnce([itemRow]);
    const result = await createWorkItem(COMPANY, CAT_ID, { name: 'Monthly Processing' });
    expect(result.id).toBe(ITEM_ID);
    expect(result.categoryId).toBe(CAT_ID);
  });
});

describe('updateWorkItem', () => {
  it('updates work item', async () => {
    const updated = { ...itemRow, name: 'Monthly Payroll Run' };
    sqlMock.mockResolvedValueOnce([itemRow]).mockResolvedValueOnce([updated]);
    const result = await updateWorkItem(COMPANY, ITEM_ID, { name: 'Monthly Payroll Run' });
    expect(result.name).toBe('Monthly Payroll Run');
  });
});

describe('seedDefaultCategories', () => {
  it('inserts default categories from reference table when company has none', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]).mockResolvedValueOnce([]);
    await expect(seedDefaultCategories(COMPANY)).resolves.toBeUndefined();
  });

  it('skips seeding when company already has categories', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 3 }]);
    await expect(seedDefaultCategories(COMPANY)).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
