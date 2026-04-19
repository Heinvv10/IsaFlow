import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface PracticeJob {
  id: string;
  companyId: string;
  practiceClientId: string;
  jobCategoryId: string | null;
  title: string;
  description: string | null;
  partnerId: string | null;
  preparerId: string | null;
  dueDate: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'new' | 'in_progress' | 'review' | 'approved' | 'billed' | 'complete' | 'cancelled';
  financialYear: string | null;
  billingType: 'hourly' | 'fixed' | 'retainer' | null;
  budgetedHours: number | null;
  fixedFeeAmount: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  practiceClientName?: string | null;
  jobCategoryName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeJobInput {
  practiceClientId: string;
  jobCategoryId?: string | null;
  title: string;
  description?: string | null;
  partnerId?: string | null;
  preparerId?: string | null;
  dueDate?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  financialYear?: string | null;
  billingType?: 'hourly' | 'fixed' | 'retainer' | null;
  budgetedHours?: number | null;
  fixedFeeAmount?: number | null;
}

export interface JobFilters {
  practiceClientId?: string;
  partnerId?: string;
  preparerId?: string;
  status?: PracticeJob['status'];
  dueBefore?: string;
}

const ALLOWED: Record<string, string[]> = {
  new:         ['in_progress', 'cancelled'],
  in_progress: ['review', 'cancelled'],
  review:      ['in_progress', 'approved', 'cancelled'],
  approved:    ['billed', 'cancelled'],
  billed:      ['complete'],
  complete:    [],
  cancelled:   [],
};

function mapJob(r: DbRow): PracticeJob {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    practiceClientId: String(r.practice_client_id),
    jobCategoryId: r.job_category_id ? String(r.job_category_id) : null,
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    partnerId: r.partner_id ? String(r.partner_id) : null,
    preparerId: r.preparer_id ? String(r.preparer_id) : null,
    dueDate: r.due_date
      ? (typeof r.due_date === 'string' ? r.due_date : (r.due_date as Date).toISOString().split('T')[0]!)
      : null,
    priority: String(r.priority) as PracticeJob['priority'],
    status: String(r.status) as PracticeJob['status'],
    financialYear: r.financial_year ? String(r.financial_year) : null,
    billingType: r.billing_type ? String(r.billing_type) as PracticeJob['billingType'] : null,
    budgetedHours: r.budgeted_hours != null ? Number(r.budgeted_hours) : null,
    fixedFeeAmount: r.fixed_fee_amount != null ? Number(r.fixed_fee_amount) : null,
    startedAt: r.started_at ? String(r.started_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    createdBy: r.created_by ? String(r.created_by) : null,
    practiceClientName: r.practice_client_name ? String(r.practice_client_name) : null,
    jobCategoryName: r.job_category_name ? String(r.job_category_name) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listJobs(
  companyId: string,
  filters?: JobFilters,
): Promise<{ jobs: PracticeJob[]; total: number }> {
  const clientId = filters?.practiceClientId ?? null;
  const partnerId = filters?.partnerId ?? null;
  const preparerId = filters?.preparerId ?? null;
  const status = filters?.status ?? null;
  const dueBefore = filters?.dueBefore ?? null;

  const countRows = (await sql`
    SELECT COUNT(*)::int AS cnt FROM practice_jobs pj
    WHERE pj.company_id = ${companyId}::UUID
      AND (${clientId}::UUID IS NULL OR pj.practice_client_id = ${clientId}::UUID)
      AND (${partnerId}::UUID IS NULL OR pj.partner_id = ${partnerId}::UUID)
      AND (${preparerId}::UUID IS NULL OR pj.preparer_id = ${preparerId}::UUID)
      AND (${status}::TEXT IS NULL OR pj.status = ${status}::TEXT)
      AND (${dueBefore}::DATE IS NULL OR pj.due_date < ${dueBefore}::DATE)
  `) as DbRow[];

  const rows = (await sql`
    SELECT pj.*,
           pc.legal_name AS practice_client_name,
           jc.name       AS job_category_name
    FROM practice_jobs pj
    LEFT JOIN practice_clients pc ON pc.id = pj.practice_client_id
    LEFT JOIN practice_job_categories jc ON jc.id = pj.job_category_id
    WHERE pj.company_id = ${companyId}::UUID
      AND (${clientId}::UUID IS NULL OR pj.practice_client_id = ${clientId}::UUID)
      AND (${partnerId}::UUID IS NULL OR pj.partner_id = ${partnerId}::UUID)
      AND (${preparerId}::UUID IS NULL OR pj.preparer_id = ${preparerId}::UUID)
      AND (${status}::TEXT IS NULL OR pj.status = ${status}::TEXT)
      AND (${dueBefore}::DATE IS NULL OR pj.due_date < ${dueBefore}::DATE)
    ORDER BY pj.due_date ASC NULLS LAST, pj.created_at DESC
  `) as DbRow[];

  return { jobs: rows.map(mapJob), total: Number(countRows[0]?.cnt ?? 0) };
}

export async function getJob(companyId: string, id: string): Promise<PracticeJob | null> {
  const rows = (await sql`
    SELECT pj.*,
           pc.legal_name AS practice_client_name,
           jc.name       AS job_category_name
    FROM practice_jobs pj
    LEFT JOIN practice_clients pc ON pc.id = pj.practice_client_id
    LEFT JOIN practice_job_categories jc ON jc.id = pj.job_category_id
    WHERE pj.id = ${id}::UUID AND pj.company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.length ? mapJob(rows[0]!) : null;
}

export async function createJob(
  companyId: string,
  userId: string,
  input: PracticeJobInput,
): Promise<PracticeJob> {
  if (!input.title.trim()) throw new Error('job title is required');

  const client = (await sql`
    SELECT id FROM practice_clients
    WHERE id = ${input.practiceClientId}::UUID
      AND company_id = ${companyId}::UUID
      AND status = 'active'
  `) as DbRow[];
  if (!client.length) throw new Error('practice client not found or not active');

  if (input.jobCategoryId) {
    const cat = (await sql`
      SELECT id FROM practice_job_categories
      WHERE id = ${input.jobCategoryId}::UUID
        AND company_id = ${companyId}::UUID
        AND is_active = true
    `) as DbRow[];
    if (!cat.length) throw new Error('job category not found or not active');
  }

  const rows = (await sql`
    INSERT INTO practice_jobs (
      company_id, practice_client_id, job_category_id, title, description,
      partner_id, preparer_id, due_date, priority, financial_year,
      billing_type, budgeted_hours, fixed_fee_amount, created_by, status
    ) VALUES (
      ${companyId}::UUID,
      ${input.practiceClientId}::UUID,
      ${input.jobCategoryId ?? null}::UUID,
      ${input.title.trim()},
      ${input.description ?? null},
      ${input.partnerId ?? null}::UUID,
      ${input.preparerId ?? null}::UUID,
      ${input.dueDate ?? null}::DATE,
      ${input.priority ?? 'normal'},
      ${input.financialYear ?? null},
      ${input.billingType ?? null},
      ${input.budgetedHours ?? null},
      ${input.fixedFeeAmount ?? null},
      ${userId}::UUID,
      'new'
    ) RETURNING *,
      (SELECT legal_name FROM practice_clients WHERE id = practice_client_id) AS practice_client_name,
      (SELECT name FROM practice_job_categories WHERE id = job_category_id) AS job_category_name`) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Created practice job', { id: rows[0].id, companyId }, 'practice');
  return mapJob(rows[0]);
}

export async function updateJob(
  companyId: string,
  id: string,
  input: Partial<PracticeJobInput>,
): Promise<PracticeJob> {
  const existing = (await sql`
    SELECT id FROM practice_jobs WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  if (input.title !== undefined && !input.title.trim()) throw new Error('job title is required');

  if (input.jobCategoryId) {
    const cat = (await sql`
      SELECT id FROM practice_job_categories
      WHERE id = ${input.jobCategoryId}::UUID
        AND company_id = ${companyId}::UUID
        AND is_active = true
    `) as DbRow[];
    if (!cat.length) throw new Error('job category not found or not active');
  }

  const rows = (await sql`
    UPDATE practice_jobs SET
      practice_client_id = COALESCE(${input.practiceClientId ?? null}::UUID, practice_client_id),
      job_category_id    = COALESCE(${input.jobCategoryId ?? null}::UUID, job_category_id),
      title              = COALESCE(${input.title ? input.title.trim() : null}, title),
      description        = COALESCE(${input.description ?? null}, description),
      partner_id         = COALESCE(${input.partnerId ?? null}::UUID, partner_id),
      preparer_id        = COALESCE(${input.preparerId ?? null}::UUID, preparer_id),
      due_date           = COALESCE(${input.dueDate ?? null}::DATE, due_date),
      priority           = COALESCE(${input.priority ?? null}, priority),
      financial_year     = COALESCE(${input.financialYear ?? null}, financial_year),
      billing_type       = COALESCE(${input.billingType ?? null}, billing_type),
      budgeted_hours     = COALESCE(${input.budgetedHours ?? null}, budgeted_hours),
      fixed_fee_amount   = COALESCE(${input.fixedFeeAmount ?? null}, fixed_fee_amount),
      updated_at         = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *,
      (SELECT legal_name FROM practice_clients WHERE id = practice_client_id) AS practice_client_name,
      (SELECT name FROM practice_job_categories WHERE id = job_category_id) AS job_category_name`) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Updated practice job', { id }, 'practice');
  return mapJob(rows[0]);
}

const DELETE_BLOCKED = 'cannot delete job with existing tasks or time entries — cancel it instead';

export async function deleteJob(companyId: string, id: string): Promise<void> {
  const hasTasks = (await sql`SELECT 1 FROM practice_tasks WHERE job_id = ${id}::UUID LIMIT 1`) as DbRow[];
  if (hasTasks.length) throw new Error(DELETE_BLOCKED);
  const hasEntries = (await sql`SELECT 1 FROM time_entries WHERE job_id = ${id}::UUID LIMIT 1`) as DbRow[];
  if (hasEntries.length) throw new Error(DELETE_BLOCKED);
  await sql`DELETE FROM practice_jobs WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
  log.info('Deleted practice job', { id, companyId }, 'practice');
}

export async function transitionJob(
  companyId: string,
  id: string,
  newStatus: PracticeJob['status'],
  userId: string,
): Promise<PracticeJob> {
  const current = (await sql`
    SELECT id, status, started_at FROM practice_jobs
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!current.length) throw new Error('not found');

  const row = current[0]!;
  const currentStatus = String(row.status);
  const allowed = ALLOWED[currentStatus] ?? [];

  if (!allowed.includes(newStatus)) {
    throw new Error(`invalid status transition from ${currentStatus} to ${newStatus}`);
  }

  const setStartedAt = newStatus === 'in_progress' && !row.started_at;
  const setCompletedAt = newStatus === 'complete';

  const updated = (await sql`
    UPDATE practice_jobs SET
      status       = ${newStatus},
      started_at   = CASE WHEN ${setStartedAt} THEN NOW() ELSE started_at END,
      completed_at = CASE WHEN ${setCompletedAt} THEN NOW() ELSE completed_at END,
      updated_at   = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *,
      (SELECT legal_name FROM practice_clients WHERE id = practice_client_id) AS practice_client_name,
      (SELECT name FROM practice_job_categories WHERE id = job_category_id) AS job_category_name
  `) as DbRow[];

  if (!updated[0]) throw new Error('database returned no row after insert/update');
  log.info('Transitioned practice job', { id, from: currentStatus, to: newStatus, userId }, 'practice');
  return mapJob(updated[0]);
}
