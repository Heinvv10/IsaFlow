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
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  transitionTask,
  generateNextRecurringInstance,
} from '@/modules/accounting/services/practice/practiceTaskService';

const COMPANY  = 'aaaaaaaa-0000-0000-0000-000000000001';
const TASK_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const JOB_ID   = 'cccccccc-0000-0000-0000-000000000003';
const USER_ID  = 'eeeeeeee-0000-0000-0000-000000000005';
const PARENT_ID = 'ffffffff-0000-0000-0000-000000000006';

const taskRow = {
  id: TASK_ID,
  company_id: COMPANY,
  job_id: JOB_ID,
  parent_task_id: null,
  title: 'Prepare balance sheet',
  description: 'Q1 balance sheet reconciliation',
  assigned_to: USER_ID,
  due_date: new Date('2026-03-31'),
  priority: 'normal',
  status: 'pending',
  recurring_rule: null,
  completed_at: null,
  created_by: USER_ID,
  job_title: 'Annual Tax Return 2025',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

beforeEach(() => vi.clearAllMocks());

// ─── listTasks ────────────────────────────────────────────────────────────────

describe('listTasks', () => {
  it('returns mapped tasks and count', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]).mockResolvedValueOnce([taskRow]);
    const result = await listTasks(COMPANY);
    expect(result.total).toBe(1);
    expect(result.tasks[0]!.title).toBe('Prepare balance sheet');
    expect(result.tasks[0]!.jobTitle).toBe('Annual Tax Return 2025');
    expect(result.tasks[0]!.companyId).toBe(COMPANY);
    expect(result.tasks[0]!.dueDate).toBe('2026-03-31');
  });

  it('filters by assignedTo and status', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]).mockResolvedValueOnce([taskRow]);
    const result = await listTasks(COMPANY, { assignedTo: USER_ID, status: 'pending' });
    expect(result.total).toBe(1);
    expect(result.tasks[0]!.assignedTo).toBe(USER_ID);
  });

  it('overdueOnly excludes done/cancelled and includes past-due pending', async () => {
    const overdueRow = {
      ...taskRow,
      due_date: new Date('2025-01-01'),
      status: 'pending',
    };
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]).mockResolvedValueOnce([overdueRow]);
    const result = await listTasks(COMPANY, { overdueOnly: true });
    expect(result.total).toBe(1);
    expect(result.tasks[0]!.status).toBe('pending');
    expect(result.tasks[0]!.dueDate).toBe('2025-01-01');
  });
});

// ─── getTask ──────────────────────────────────────────────────────────────────

describe('getTask', () => {
  it('returns null when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await getTask(COMPANY, TASK_ID);
    expect(result).toBeNull();
  });

  it('returns mapped task with joined job_title', async () => {
    sqlMock.mockResolvedValueOnce([taskRow]);
    const result = await getTask(COMPANY, TASK_ID);
    expect(result?.id).toBe(TASK_ID);
    expect(result?.jobTitle).toBe('Annual Tax Return 2025');
    expect(result?.dueDate).toBe('2026-03-31');
    expect(result?.status).toBe('pending');
  });
});

// ─── createTask ───────────────────────────────────────────────────────────────

describe('createTask', () => {
  it('rejects empty title', async () => {
    await expect(
      createTask(COMPANY, USER_ID, { title: '   ' }),
    ).rejects.toThrow('task title is required');
  });

  it('rejects cancelled job', async () => {
    // job lookup returns empty (cancelled or not found)
    sqlMock.mockResolvedValueOnce([]);
    await expect(
      createTask(COMPANY, USER_ID, { title: 'Do something', jobId: JOB_ID }),
    ).rejects.toThrow('job not found or cancelled');
  });

  it('creates task with defaults (priority=normal, status=pending, created_by set)', async () => {
    // no jobId or parentTaskId provided → straight to insert
    sqlMock.mockResolvedValueOnce([{ ...taskRow, job_id: null, job_title: null }]);
    const result = await createTask(COMPANY, USER_ID, { title: 'Prepare balance sheet' });
    expect(result.status).toBe('pending');
    expect(result.priority).toBe('normal');
    expect(result.createdBy).toBe(USER_ID);
    expect(result.id).toBe(TASK_ID);
  });
});

// ─── updateTask ───────────────────────────────────────────────────────────────

describe('updateTask', () => {
  it('throws when task not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(updateTask(COMPANY, TASK_ID, { title: 'New title' })).rejects.toThrow('task not found');
  });

  it('updates and returns modified task', async () => {
    const updatedRow = { ...taskRow, title: 'Updated title', updated_at: new Date() };
    // exist check
    sqlMock.mockResolvedValueOnce([{ id: TASK_ID }]);
    // update returning
    sqlMock.mockResolvedValueOnce([updatedRow]);
    const result = await updateTask(COMPANY, TASK_ID, { title: 'Updated title' });
    expect(result.title).toBe('Updated title');
  });
});

// ─── deleteTask ───────────────────────────────────────────────────────────────

describe('deleteTask', () => {
  it('hard deletes without checking children', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(deleteTask(COMPANY, TASK_ID)).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

// ─── transitionTask ───────────────────────────────────────────────────────────

describe('transitionTask', () => {
  it('rejects done → pending (terminal status)', async () => {
    sqlMock.mockResolvedValueOnce([{ id: TASK_ID, status: 'done', completed_at: new Date() }]);
    await expect(transitionTask(COMPANY, TASK_ID, 'pending')).rejects.toThrow(
      'invalid status transition from done to pending',
    );
  });

  it('pending → done stamps completed_at', async () => {
    sqlMock.mockResolvedValueOnce([{ id: TASK_ID, status: 'pending', completed_at: null }]);
    const updatedRow = { ...taskRow, status: 'done', completed_at: new Date() };
    sqlMock.mockResolvedValueOnce([updatedRow]);
    const result = await transitionTask(COMPANY, TASK_ID, 'done');
    expect(result.status).toBe('done');
    expect(result.completedAt).not.toBeNull();
  });
});

// ─── generateNextRecurringInstance ───────────────────────────────────────────

describe('generateNextRecurringInstance', () => {
  it('rejects source with no recurring_rule', async () => {
    // getTask calls sql once
    sqlMock.mockResolvedValueOnce([{ ...taskRow, recurring_rule: null }]);
    await expect(
      generateNextRecurringInstance(COMPANY, USER_ID, TASK_ID),
    ).rejects.toThrow('source task has no recurring rule');
  });

  it('rejects source with no due_date', async () => {
    sqlMock.mockResolvedValueOnce([{ ...taskRow, recurring_rule: 'monthly', due_date: null }]);
    await expect(
      generateNextRecurringInstance(COMPANY, USER_ID, TASK_ID),
    ).rejects.toThrow('source task has no due date — cannot compute next instance');
  });

  it('monthly simple case: 2026-01-15 → 2026-02-15', async () => {
    sqlMock.mockResolvedValueOnce([{
      ...taskRow,
      recurring_rule: 'monthly',
      due_date: new Date('2026-01-15'),
    }]);
    const newRow = { ...taskRow, id: 'newid', due_date: new Date('2026-02-15'), status: 'pending', completed_at: null };
    sqlMock.mockResolvedValueOnce([newRow]);
    const result = await generateNextRecurringInstance(COMPANY, USER_ID, TASK_ID);
    expect(result.dueDate).toBe('2026-02-15');
    expect(result.status).toBe('pending');
    expect(result.completedAt).toBeNull();
  });

  it('monthly clamps Jan-31 → Feb-28', async () => {
    sqlMock.mockResolvedValueOnce([{
      ...taskRow,
      recurring_rule: 'monthly',
      due_date: new Date('2026-01-31'),
    }]);
    const newRow = { ...taskRow, id: 'newid2', due_date: new Date('2026-02-28'), status: 'pending', completed_at: null };
    sqlMock.mockResolvedValueOnce([newRow]);
    const result = await generateNextRecurringInstance(COMPANY, USER_ID, TASK_ID);
    expect(result.dueDate).toBe('2026-02-28');
  });

  it('weekly adds 7 days: 2026-03-01 → 2026-03-08', async () => {
    sqlMock.mockResolvedValueOnce([{
      ...taskRow,
      recurring_rule: 'weekly',
      due_date: new Date('2026-03-01'),
    }]);
    const newRow = { ...taskRow, id: 'newid3', due_date: new Date('2026-03-08'), status: 'pending', completed_at: null };
    sqlMock.mockResolvedValueOnce([newRow]);
    const result = await generateNextRecurringInstance(COMPANY, USER_ID, TASK_ID);
    expect(result.dueDate).toBe('2026-03-08');
  });
});
