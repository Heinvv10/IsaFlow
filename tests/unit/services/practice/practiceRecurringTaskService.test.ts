// RED phase — written before implementation
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceTaskService', () => ({
  generateNextRecurringInstance: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { generateNextRecurringInstance } from '@/modules/accounting/services/practice/practiceTaskService';
import { sweepRecurringTasks } from '@/modules/accounting/services/practice/practiceRecurringTaskService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const generateMock = generateNextRecurringInstance as ReturnType<typeof vi.fn>;
const logMock = log as { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TASK_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID    = 'cccccccc-0000-0000-0000-000000000003';
const NEW_TASK_ID = 'dddddddd-0000-0000-0000-000000000004';

function makeCompanyRow(id = COMPANY_ID) {
  return { id };
}

function makeSourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    created_by: USER_ID,
    recurring_rule: 'monthly',
    due_date: '2026-03-01',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sweepRecurringTasks', () => {
  it('returns zeros when no companies exist', async () => {
    // First call: companies query — returns empty
    sqlMock.mockResolvedValueOnce([]);

    const result = await sweepRecurringTasks();

    expect(result).toEqual({
      companiesProcessed: 0,
      tasksConsidered: 0,
      tasksGenerated: 0,
      errors: [],
    });
  });

  it('skips source tasks with null created_by and logs a warning', async () => {
    // companies query
    sqlMock.mockResolvedValueOnce([makeCompanyRow()]);
    // source tasks query — one task with null created_by
    sqlMock.mockResolvedValueOnce([makeSourceRow({ created_by: null })]);

    const result = await sweepRecurringTasks();

    expect(result.tasksConsidered).toBe(1);
    expect(result.tasksGenerated).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('created_by'),
      expect.objectContaining({ taskId: TASK_ID }),
      expect.any(String),
    );
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('generates next instance and stamps parent_task_id for eligible source task', async () => {
    // companies query
    sqlMock.mockResolvedValueOnce([makeCompanyRow()]);
    // source tasks query
    sqlMock.mockResolvedValueOnce([makeSourceRow()]);
    // generateNextRecurringInstance returns the new task
    generateMock.mockResolvedValueOnce({ id: NEW_TASK_ID, companyId: COMPANY_ID });
    // parent_task_id UPDATE
    sqlMock.mockResolvedValueOnce([{ id: NEW_TASK_ID }]);

    const result = await sweepRecurringTasks();

    expect(result.companiesProcessed).toBe(1);
    expect(result.tasksConsidered).toBe(1);
    expect(result.tasksGenerated).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(generateMock).toHaveBeenCalledWith(COMPANY_ID, USER_ID, TASK_ID);
    // Verify the UPDATE was issued — find the call whose template strings include UPDATE + SET parent_task_id
    // sql`` tagged template: args[0] is TemplateStringsArray, rest are interpolated values
    const updateCall = sqlMock.mock.calls.find(
      (args: unknown[]) =>
        Array.isArray(args[0]) &&
        (args[0] as string[]).some((s: string) => s.includes('UPDATE practice_tasks')),
    );
    expect(updateCall).toBeDefined();
    // The interpolated values include sourceTaskId (TASK_ID), newTaskId (NEW_TASK_ID), companyId
    const interpolatedValues = (updateCall as unknown[]).slice(1);
    expect(interpolatedValues).toContain(TASK_ID);
    expect(interpolatedValues).toContain(NEW_TASK_ID);
  });

  it('continues sweep when a single task throws and records the error', async () => {
    const TASK_ID_2 = 'eeeeeeee-0000-0000-0000-000000000005';
    // companies
    sqlMock.mockResolvedValueOnce([makeCompanyRow()]);
    // two source tasks
    sqlMock.mockResolvedValueOnce([
      makeSourceRow({ id: TASK_ID }),
      makeSourceRow({ id: TASK_ID_2 }),
    ]);
    // first task fails
    generateMock.mockRejectedValueOnce(new Error('DB timeout'));
    // second task succeeds
    generateMock.mockResolvedValueOnce({ id: NEW_TASK_ID, companyId: COMPANY_ID });
    // parent_task_id UPDATE for second task
    sqlMock.mockResolvedValueOnce([{ id: NEW_TASK_ID }]);

    const result = await sweepRecurringTasks();

    expect(result.tasksConsidered).toBe(2);
    expect(result.tasksGenerated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      error: 'DB timeout',
    });
  });

  it('returns zero tasksConsidered when SQL returns no eligible source tasks (dedupe / no overdue)', async () => {
    // companies
    sqlMock.mockResolvedValueOnce([makeCompanyRow()]);
    // source tasks query returns empty (NOT EXISTS clause excluded everything)
    sqlMock.mockResolvedValueOnce([]);

    const result = await sweepRecurringTasks();

    expect(result.companiesProcessed).toBe(1);
    expect(result.tasksConsidered).toBe(0);
    expect(result.tasksGenerated).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('processes multiple companies independently', async () => {
    const COMPANY_ID_2 = 'ffffffff-0000-0000-0000-000000000006';
    // companies
    sqlMock.mockResolvedValueOnce([makeCompanyRow(COMPANY_ID), makeCompanyRow(COMPANY_ID_2)]);
    // tasks for company 1 — one eligible
    sqlMock.mockResolvedValueOnce([makeSourceRow()]);
    // generate for company 1
    generateMock.mockResolvedValueOnce({ id: NEW_TASK_ID, companyId: COMPANY_ID });
    // parent_task_id UPDATE for company 1
    sqlMock.mockResolvedValueOnce([{ id: NEW_TASK_ID }]);
    // tasks for company 2 — none
    sqlMock.mockResolvedValueOnce([]);

    const result = await sweepRecurringTasks();

    expect(result.companiesProcessed).toBe(2);
    expect(result.tasksConsidered).toBe(1);
    expect(result.tasksGenerated).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
