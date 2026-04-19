import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface PracticeTask {
  id: string;
  companyId: string;
  jobId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  assignedTo: string | null;
  dueDate: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  recurringRule: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null;
  completedAt: string | null;
  createdBy: string | null;
  jobTitle?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeTaskInput {
  jobId?: string | null;
  parentTaskId?: string | null;
  title: string;
  description?: string | null;
  assignedTo?: string | null;
  dueDate?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  recurringRule?: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null;
}

export interface TaskFilters {
  jobId?: string;
  assignedTo?: string;
  status?: PracticeTask['status'];
  overdueOnly?: boolean;
  parentTaskId?: string;
}

// Date math helpers (UTC)
function addDays(s: string, days: number): string {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().split('T')[0]!;
}
function addMonths(s: string, months: number): string {
  const [y, m, d] = s.split('-').map(Number);
  const base = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const yr = base.getUTCFullYear(), mo = base.getUTCMonth();
  const last = new Date(Date.UTC(yr, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(yr, mo, Math.min(d!, last))).toISOString().split('T')[0]!;
}
function computeNextDueDate(s: string, rule: NonNullable<PracticeTask['recurringRule']>): string {
  switch (rule) {
    case 'weekly':    return addDays(s, 7);
    case 'monthly':   return addMonths(s, 1);
    case 'quarterly': return addMonths(s, 3);
    case 'yearly':    return addMonths(s, 12);
  }
}
function toDateStr(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.split('T')[0]!;
  if (v instanceof Date) return v.toISOString().split('T')[0]!;
  return null;
}

function mapTask(r: DbRow): PracticeTask {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    jobId: r.job_id ? String(r.job_id) : null,
    parentTaskId: r.parent_task_id ? String(r.parent_task_id) : null,
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    assignedTo: r.assigned_to ? String(r.assigned_to) : null,
    dueDate: toDateStr(r.due_date),
    priority: String(r.priority) as PracticeTask['priority'],
    status: String(r.status) as PracticeTask['status'],
    recurringRule: r.recurring_rule ? String(r.recurring_rule) as PracticeTask['recurringRule'] : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    createdBy: r.created_by ? String(r.created_by) : null,
    jobTitle: r.job_title ? String(r.job_title) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
const ALLOWED: Record<string, string[]> = {
  pending:     ['in_progress', 'done', 'cancelled'],
  in_progress: ['pending', 'done', 'cancelled'],
  done:        [],
  cancelled:   [],
};
export async function listTasks(
  companyId: string,
  filters?: TaskFilters,
): Promise<{ tasks: PracticeTask[]; total: number }> {
  const jobId       = filters?.jobId       ?? null;
  const assignedTo  = filters?.assignedTo  ?? null;
  const status      = filters?.status      ?? null;
  const overdueOnly = filters?.overdueOnly ?? false;
  const parentId    = filters?.parentTaskId ?? null;

  const countRows = (await sql`
    SELECT COUNT(*)::int AS cnt FROM practice_tasks pt
    WHERE pt.company_id = ${companyId}::UUID
      AND (${jobId}::UUID IS NULL      OR pt.job_id      = ${jobId}::UUID)
      AND (${assignedTo}::UUID IS NULL OR pt.assigned_to = ${assignedTo}::UUID)
      AND (${status}::TEXT IS NULL     OR pt.status      = ${status}::TEXT)
      AND (${parentId}::UUID IS NULL   OR pt.parent_task_id = ${parentId}::UUID)
      AND (NOT ${overdueOnly} OR (pt.status NOT IN ('done','cancelled') AND pt.due_date < CURRENT_DATE))
  `) as DbRow[];

  const rows = (await sql`
    SELECT pt.*,
           pj.title AS job_title
    FROM practice_tasks pt
    LEFT JOIN practice_jobs pj ON pj.id = pt.job_id
    WHERE pt.company_id = ${companyId}::UUID
      AND (${jobId}::UUID IS NULL      OR pt.job_id      = ${jobId}::UUID)
      AND (${assignedTo}::UUID IS NULL OR pt.assigned_to = ${assignedTo}::UUID)
      AND (${status}::TEXT IS NULL     OR pt.status      = ${status}::TEXT)
      AND (${parentId}::UUID IS NULL   OR pt.parent_task_id = ${parentId}::UUID)
      AND (NOT ${overdueOnly} OR (pt.status NOT IN ('done','cancelled') AND pt.due_date < CURRENT_DATE))
    ORDER BY pt.due_date ASC NULLS LAST, pt.created_at DESC
  `) as DbRow[];

  return { tasks: rows.map(mapTask), total: Number(countRows[0]?.cnt ?? 0) };
}
export async function getTask(companyId: string, id: string): Promise<PracticeTask | null> {
  const rows = (await sql`
    SELECT pt.*,
           pj.title AS job_title
    FROM practice_tasks pt
    LEFT JOIN practice_jobs pj ON pj.id = pt.job_id
    WHERE pt.id = ${id}::UUID AND pt.company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.length ? mapTask(rows[0]!) : null;
}

export async function createTask(
  companyId: string,
  userId: string,
  input: PracticeTaskInput,
): Promise<PracticeTask> {
  if (!input.title.trim()) throw new Error('task title is required');

  if (input.jobId) {
    const job = (await sql`
      SELECT id FROM practice_jobs
      WHERE id = ${input.jobId}::UUID
        AND company_id = ${companyId}::UUID
        AND status != 'cancelled'
    `) as DbRow[];
    if (!job.length) throw new Error('job not found or cancelled');
  }

  if (input.parentTaskId) {
    const parent = (await sql`
      SELECT id FROM practice_tasks
      WHERE id = ${input.parentTaskId}::UUID
        AND company_id = ${companyId}::UUID
    `) as DbRow[];
    if (!parent.length) throw new Error('parent task invalid');
  }

  const rows = (await sql`
    INSERT INTO practice_tasks (company_id, job_id, parent_task_id, title, description,
      assigned_to, due_date, priority, status, recurring_rule, created_by)
    VALUES (
      ${companyId}::UUID, ${input.jobId ?? null}::UUID, ${input.parentTaskId ?? null}::UUID,
      ${input.title.trim()}, ${input.description ?? null}, ${input.assignedTo ?? null}::UUID,
      ${input.dueDate ?? null}::DATE, ${input.priority ?? 'normal'}, 'pending',
      ${input.recurringRule ?? null}, ${userId}::UUID
    ) RETURNING *, (SELECT title FROM practice_jobs WHERE id = job_id) AS job_title
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after insert');
  log.info('Created practice task', { id: rows[0].id, companyId }, 'practice');
  return mapTask(rows[0]);
}

export async function updateTask(
  companyId: string,
  id: string,
  input: Partial<PracticeTaskInput>,
): Promise<PracticeTask> {
  const existing = (await sql`
    SELECT id FROM practice_tasks WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('task not found');

  if (input.jobId) {
    const job = (await sql`
      SELECT id FROM practice_jobs
      WHERE id = ${input.jobId}::UUID
        AND company_id = ${companyId}::UUID
        AND status != 'cancelled'
    `) as DbRow[];
    if (!job.length) throw new Error('job not found or cancelled');
  }

  if (input.parentTaskId) {
    if (input.parentTaskId === id) throw new Error('parent task invalid');
    const parent = (await sql`
      SELECT id FROM practice_tasks
      WHERE id = ${input.parentTaskId}::UUID
        AND company_id = ${companyId}::UUID
    `) as DbRow[];
    if (!parent.length) throw new Error('parent task invalid');
  }

  const rows = (await sql`
    UPDATE practice_tasks SET
      job_id         = COALESCE(${input.jobId ?? null}::UUID, job_id),
      parent_task_id = COALESCE(${input.parentTaskId ?? null}::UUID, parent_task_id),
      title          = COALESCE(${input.title ? input.title.trim() : null}, title),
      description    = COALESCE(${input.description ?? null}, description),
      assigned_to    = COALESCE(${input.assignedTo ?? null}::UUID, assigned_to),
      due_date       = COALESCE(${input.dueDate ?? null}::DATE, due_date),
      priority       = COALESCE(${input.priority ?? null}, priority),
      recurring_rule = COALESCE(${input.recurringRule ?? null}, recurring_rule),
      updated_at     = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *, (SELECT title FROM practice_jobs WHERE id = job_id) AS job_title
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after update');
  log.info('Updated practice task', { id, companyId }, 'practice');
  return mapTask(rows[0]);
}

export async function deleteTask(companyId: string, id: string): Promise<void> {
  await sql`DELETE FROM practice_tasks WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
  log.info('Deleted practice task', { id, companyId }, 'practice');
}

export async function transitionTask(
  companyId: string,
  id: string,
  newStatus: PracticeTask['status'],
): Promise<PracticeTask> {
  const current = (await sql`
    SELECT id, status, completed_at FROM practice_tasks
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!current.length) throw new Error('task not found');

  const row = current[0]!;
  const currentStatus = String(row.status);
  const allowed = ALLOWED[currentStatus] ?? [];

  if (!allowed.includes(newStatus)) {
    throw new Error(`invalid status transition from ${currentStatus} to ${newStatus}`);
  }

  const setCompletedAt = newStatus === 'done';

  const updated = (await sql`
    UPDATE practice_tasks SET
      status       = ${newStatus},
      completed_at = CASE WHEN ${setCompletedAt} THEN NOW() ELSE completed_at END,
      updated_at   = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *, (SELECT title FROM practice_jobs WHERE id = job_id) AS job_title
  `) as DbRow[];

  if (!updated[0]) throw new Error('database returned no row after transition');
  log.info('Transitioned practice task', { id, from: currentStatus, to: newStatus }, 'practice');
  return mapTask(updated[0]);
}

export async function generateNextRecurringInstance(
  companyId: string,
  userId: string,
  sourceTaskId: string,
): Promise<PracticeTask> {
  const source = await getTask(companyId, sourceTaskId);
  if (!source) throw new Error('source task not found');
  if (!source.recurringRule) throw new Error('source task has no recurring rule');
  if (!source.dueDate) throw new Error('source task has no due date — cannot compute next instance');

  const nextDueDate = computeNextDueDate(source.dueDate, source.recurringRule);

  const rows = (await sql`
    INSERT INTO practice_tasks (company_id, job_id, parent_task_id, title, description,
      assigned_to, due_date, priority, status, recurring_rule, completed_at, created_by)
    VALUES (
      ${companyId}::UUID, ${source.jobId ?? null}::UUID, ${source.parentTaskId ?? null}::UUID,
      ${source.title}, ${source.description ?? null}, ${source.assignedTo ?? null}::UUID,
      ${nextDueDate}::DATE, ${source.priority}, 'pending', ${source.recurringRule},
      NULL, ${userId}::UUID
    ) RETURNING *, (SELECT title FROM practice_jobs WHERE id = job_id) AS job_title
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after recurring insert');
  log.info('Generated recurring task instance', { sourceTaskId, nextDueDate, companyId }, 'practice');
  return mapTask(rows[0]);
}
