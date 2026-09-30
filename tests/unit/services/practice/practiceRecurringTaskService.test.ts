// RED phase — written before implementation
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceUsersService', () => ({
  listCompanyUsersForSystem: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listCompanyUsersForSystem } from '@/modules/accounting/services/practice/practiceUsersService';
import { sweepRecurringTasks } from '@/modules/accounting/services/practice/practiceRecurringTaskService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const usersMock = listCompanyUsersForSystem as ReturnType<typeof vi.fn>;
const logMock = log as { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TASK_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID    = 'cccccccc-0000-0000-0000-000000000003';
const NEW_TASK_ID = 'dddddddd-0000-0000-0000-000000000004';
const JOB_ID     = '99999999-0000-0000-0000-000000000009';

function makeCompanyRow(id = COMPANY_ID) {
  return { id };
}

function makeSourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    created_by: USER_ID,
    recurring_rule: 'monthly',
    due_date: '2026-03-01',
    job_id: JOB_ID,
    own_job_id: JOB_ID,
    assigned_to: USER_ID,
    ...overrides,
  };
}

function insertCalls() {
  return sqlMock.mock.calls.filter(
    (args: unknown[]) => Array.isArray(args[0]) && (args[0] as string[]).some((s) => s.includes('INSERT INTO practice_tasks')),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  usersMock.mockResolvedValue([{ id: USER_ID }]);
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
      tasksSkipped: 0,
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
    expect(result.tasksSkipped).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('created_by'),
      expect.objectContaining({ taskId: TASK_ID }),
      expect.any(String),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('skips a source whose creator is not a member in good standing', async () => {
    sqlMock.mockResolvedValueOnce([makeCompanyRow()]);
    sqlMock.mockResolvedValueOnce([makeSourceRow({ created_by: 'eeeeeeee-0000-0000-0000-00000000000e' })]);

    const result = await sweepRecurringTasks();

    expect(result.tasksSkipped).toBe(1);
    expect(result.tasksGenerated).toBe(0);
    expect(insertCalls()).toHaveLength(0);
  });

  it('inserts the next instance, linked to its source, one period on', async () => {
    // companies query
    sqlMock.mockResolvedValueOnce([makeCompanyRow()]);
    // source tasks query
    sqlMock.mockResolvedValueOnce([makeSourceRow()]);
    // INSERT … RETURNING id
    sqlMock.mockResolvedValueOnce([{ id: NEW_TASK_ID }]);

    const result = await sweepRecurringTasks();

    expect(result.companiesProcessed).toBe(1);
    expect(result.tasksConsidered).toBe(1);
    expect(result.tasksGenerated).toBe(1);
    expect(result.errors).toHaveLength(0);
    // sql`` tagged template: args[0] is TemplateStringsArray, rest are interpolated values
    const [insert] = insertCalls();
    expect((insert as unknown[]).slice(1)).toEqual([JOB_ID, USER_ID, '2026-04-01', TASK_ID, COMPANY_ID]);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('drops another company\'s job and an assignee outside the company, with a warning', async () => {
    sqlMock.mockResolvedValueOnce([makeCompanyRow()]);
    sqlMock.mockResolvedValueOnce([makeSourceRow({ own_job_id: null, assigned_to: 'ffffffff-0000-0000-0000-00000000000f' })]);
    sqlMock.mockResolvedValueOnce([{ id: NEW_TASK_ID }]);

    const result = await sweepRecurringTasks();

    expect(result.tasksGenerated).toBe(1);
    expect((insertCalls()[0] as unknown[]).slice(1, 3)).toEqual([null, null]);
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('outside the company'),
      expect.objectContaining({ taskId: TASK_ID, jobId: JOB_ID }),
      expect.any(String),
    );
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
    // first insert fails, second succeeds
    sqlMock.mockRejectedValueOnce(new Error('DB timeout'));
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
    expect(insertCalls()).toHaveLength(0);
    expect(usersMock).not.toHaveBeenCalled();
  });

  it('processes multiple companies independently', async () => {
    const COMPANY_ID_2 = 'ffffffff-0000-0000-0000-000000000006';
    // companies
    sqlMock.mockResolvedValueOnce([makeCompanyRow(COMPANY_ID), makeCompanyRow(COMPANY_ID_2)]);
    // tasks for company 1 — one eligible
    sqlMock.mockResolvedValueOnce([makeSourceRow()]);
    // insert for company 1
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
