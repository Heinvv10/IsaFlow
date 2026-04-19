// src/modules/accounting/services/practice/practiceRecurringTaskService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { generateNextRecurringInstance } from './practiceTaskService';

export interface RecurringSweepResult {
  companiesProcessed: number;
  tasksConsidered: number;
  tasksGenerated: number;
  errors: Array<{ companyId: string; taskId: string; error: string }>;
}

interface SourceTaskRow {
  id: string;
  created_by: string | null;
  recurring_rule: string;
  due_date: string | Date;
}

/**
 * Loads all active (non-deleted) companies.
 */
async function loadActiveCompanies(): Promise<string[]> {
  const rows = (await sql`
    SELECT id FROM companies WHERE deleted_at IS NULL
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/**
 * Returns source tasks that are resolved (done/cancelled), overdue, have a recurring rule,
 * and do NOT yet have a child task pointing back to them via parent_task_id.
 * This is the idempotency guard — the NOT EXISTS prevents double-generation.
 */
async function loadEligibleSourceTasks(companyId: string): Promise<SourceTaskRow[]> {
  const rows = (await sql`
    SELECT t.id, t.created_by, t.recurring_rule, t.due_date
    FROM practice_tasks t
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

  return rows.map((r) => ({
    id: String(r.id),
    created_by: r.created_by ? String(r.created_by) : null,
    recurring_rule: String(r.recurring_rule),
    due_date: r.due_date instanceof Date ? r.due_date.toISOString().split('T')[0]! : String(r.due_date),
  }));
}

/**
 * Stamps `parent_task_id = sourceTaskId` on the newly-created task.
 * This is what makes the NOT EXISTS de-dupe check effective on subsequent runs.
 */
async function stampParentLink(newTaskId: string, sourceTaskId: string, companyId: string): Promise<void> {
  await sql`
    UPDATE practice_tasks
    SET parent_task_id = ${sourceTaskId}::UUID
    WHERE id = ${newTaskId}::UUID AND company_id = ${companyId}::UUID
  `;
}

/**
 * Iterates over all active companies and generates the next pending instance
 * for every recurring task that has resolved (done/cancelled) and is now overdue.
 *
 * Idempotent: the NOT EXISTS check on parent_task_id prevents double-generation.
 * Per-task errors are captured and do not abort the rest of the sweep.
 */
export async function sweepRecurringTasks(): Promise<RecurringSweepResult> {
  log.info('Starting recurring task sweep', {}, 'practiceRecurringTaskService');

  const companyIds = await loadActiveCompanies();

  let tasksConsidered = 0;
  let tasksGenerated = 0;
  const errors: RecurringSweepResult['errors'] = [];

  for (const companyId of companyIds) {
    const sourceTasks = await loadEligibleSourceTasks(companyId);
    tasksConsidered += sourceTasks.length;

    for (const task of sourceTasks) {
      if (!task.created_by) {
        log.warn(
          'Skipping recurring task: created_by is null',
          { taskId: task.id, companyId },
          'practiceRecurringTaskService',
        );
        continue;
      }

      try {
        const created = await generateNextRecurringInstance(companyId, task.created_by, task.id);
        await stampParentLink(created.id, task.id, companyId);
        tasksGenerated++;
        log.info(
          'Generated recurring task instance',
          { sourceTaskId: task.id, newTaskId: created.id, companyId },
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
    errors,
  };

  log.info('Recurring task sweep complete', result, 'practiceRecurringTaskService');
  return result;
}
