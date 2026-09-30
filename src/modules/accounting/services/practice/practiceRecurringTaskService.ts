// src/modules/accounting/services/practice/practiceRecurringTaskService.ts
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { computeNextDueDate, type PracticeTask } from './practiceTaskService';
import { listCompanyUsersForSystem } from './practiceUsersService';

export interface RecurringSweepResult {
  companiesProcessed: number;
  tasksConsidered: number;
  tasksGenerated: number;
  /** Sources left alone: no creator, or a creator who is not a member of the company in good standing. */
  tasksSkipped: number;
  errors: Array<{ companyId: string; taskId: string; error: string }>;
}

interface SourceTaskRow {
  id: string;
  created_by: string | null;
  recurring_rule: NonNullable<PracticeTask['recurringRule']>;
  due_date: string;
  job_id: string | null;
  /** job_id when that job belongs to the same company, else null. */
  own_job_id: string | null;
  assigned_to: string | null;
}

/**
 * Loads the companies in the standing withAuth enforces
 * (src/lib/auth/companyMembership.ts). There is no `deleted_at` column: the
 * admin soft delete writes status = 'deleted' (R-168, as R-162).
 */
async function loadActiveCompanies(): Promise<string[]> {
  const rows = (await sql`
    SELECT id FROM companies
    WHERE status IS DISTINCT FROM 'suspended'
      AND status IS DISTINCT FROM 'deleted'
      AND suspended_at IS NULL
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/**
 * Returns source tasks that are resolved (done/cancelled), overdue, have a recurring rule,
 * and do NOT yet have a child task pointing back to them via parent_task_id.
 * This is the idempotency guard — the NOT EXISTS prevents double-generation.
 *
 * The cron runs on the pool's own role, past RLS, and practice_tasks.job_id is
 * not tenant-bound: `own_job_id` is the job only when it is this company's (R-168).
 */
async function loadEligibleSourceTasks(companyId: string): Promise<SourceTaskRow[]> {
  const rows = (await sql`
    SELECT t.id, t.created_by, t.recurring_rule, t.due_date, t.job_id, t.assigned_to,
           pj.id AS own_job_id
    FROM practice_tasks t
    LEFT JOIN practice_jobs pj ON pj.id = t.job_id AND pj.company_id = t.company_id
    WHERE t.company_id = ${companyId}::UUID
      AND t.recurring_rule IS NOT NULL
      AND t.status IN ('done', 'cancelled')
      AND t.due_date IS NOT NULL
      AND t.due_date <= CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM practice_tasks child
        WHERE child.company_id = t.company_id
          AND child.parent_task_id = t.id
      )
  `) as DbRow[];

  const str = (v: unknown) => (v ? String(v) : null);
  return rows.map((r) => ({
    id: String(r.id),
    created_by: str(r.created_by),
    recurring_rule: String(r.recurring_rule) as SourceTaskRow['recurring_rule'],
    due_date: fmtDate(r.due_date),
    job_id: str(r.job_id),
    own_job_id: str(r.own_job_id),
    assigned_to: str(r.assigned_to),
  }));
}

/**
 * Inserts the next pending instance of `task`, linked back to it by
 * parent_task_id in the same statement (the NOT EXISTS de-dupe above reads that
 * link). Job and assignee are the caller's fenced values, not the source's.
 */
async function insertNextInstance(
  companyId: string,
  task: SourceTaskRow,
  jobId: string | null,
  assignedTo: string | null,
): Promise<string> {
  const nextDueDate = computeNextDueDate(task.due_date, task.recurring_rule);
  const rows = (await sql`
    INSERT INTO practice_tasks (company_id, job_id, parent_task_id, title, description,
      assigned_to, due_date, priority, status, recurring_rule, completed_at, created_by)
    SELECT s.company_id, ${jobId}::UUID, s.id, s.title, s.description,
      ${assignedTo}::UUID, ${nextDueDate}::DATE, s.priority, 'pending', s.recurring_rule,
      NULL, s.created_by
    FROM practice_tasks s
    WHERE s.id = ${task.id}::UUID AND s.company_id = ${companyId}::UUID
    RETURNING id
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after recurring insert');
  return String(rows[0].id);
}

/**
 * Iterates over all active companies and generates the next pending instance
 * for every recurring task that has resolved (done/cancelled) and is now overdue.
 *
 * A generated task never links outside its company (R-168): another company's
 * job is not copied, an assignee who is not a member in good standing
 * (listCompanyUsersForSystem) is dropped, and a source whose creator is not one
 * is skipped.
 *
 * Idempotent: the NOT EXISTS check on parent_task_id prevents double-generation.
 * Per-task errors are captured and do not abort the rest of the sweep.
 */
export async function sweepRecurringTasks(): Promise<RecurringSweepResult> {
  log.info('Starting recurring task sweep', {}, 'practiceRecurringTaskService');

  const companyIds = await loadActiveCompanies();

  let tasksConsidered = 0;
  let tasksGenerated = 0;
  let tasksSkipped = 0;
  const errors: RecurringSweepResult['errors'] = [];

  for (const companyId of companyIds) {
    const sourceTasks = await loadEligibleSourceTasks(companyId);
    tasksConsidered += sourceTasks.length;
    if (sourceTasks.length === 0) continue;

    const members = new Set((await listCompanyUsersForSystem(companyId)).map((u) => u.id));

    for (const task of sourceTasks) {
      if (!task.created_by || !members.has(task.created_by)) {
        tasksSkipped++;
        log.warn(
          'Skipping recurring task: created_by is null or not a member in good standing',
          { taskId: task.id, companyId, createdBy: task.created_by },
          'practiceRecurringTaskService',
        );
        continue;
      }

      const assignedTo = task.assigned_to && members.has(task.assigned_to) ? task.assigned_to : null;
      if (task.job_id !== task.own_job_id || task.assigned_to !== assignedTo) {
        log.warn(
          'Recurring task instance: dropped a job or assignee outside the company',
          { taskId: task.id, companyId, jobId: task.job_id, assignedTo: task.assigned_to },
          'practiceRecurringTaskService',
        );
      }

      try {
        const newTaskId = await insertNextInstance(companyId, task, task.own_job_id, assignedTo);
        tasksGenerated++;
        log.info(
          'Generated recurring task instance',
          { sourceTaskId: task.id, newTaskId, companyId },
          'practiceRecurringTaskService',
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ companyId, taskId: task.id, error: errorMsg });
        log.error(
          'Failed to generate recurring task instance',
          { companyId, taskId: task.id, error: errorMsg },
          'practiceRecurringTaskService',
        );
      }
    }
  }

  const result: RecurringSweepResult = {
    companiesProcessed: companyIds.length,
    tasksConsidered,
    tasksGenerated,
    tasksSkipped,
    errors,
  };

  log.info('Recurring task sweep complete', result, 'practiceRecurringTaskService');
  return result;
}
