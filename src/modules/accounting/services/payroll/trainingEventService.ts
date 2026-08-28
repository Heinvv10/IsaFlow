/**
 * Workplace Skills Plan / Annual Training Report capture (mig 457).
 *
 * Planned vs actual training on one row; wspAtrReport rolls the rows up
 * by category + status + cost for the SETA submission pack.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

export type TrainingCategory =
  | 'aet'
  | 'learnership'
  | 'skills_programme'
  | 'internship'
  | 'bursary'
  | 'short_course'
  | 'workshop'
  | 'other';

export type TrainingStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled';

export interface TrainingEvent {
  id: string;
  companyId: string;
  employeeId: string;
  category: TrainingCategory;
  description: string;
  provider: string | null;
  nqfLevel: number | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  costPlanned: number;
  costActual: number;
  status: TrainingStatus;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class TrainingEventNotFoundError extends Error {
  constructor(id: string) {
    super(`Training event ${id} not found`);
    this.name = 'TrainingEventNotFoundError';
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function dateOrNull(v: unknown): string | null {
  if (v == null) return null;
  return fmtDate(v);
}

function mapRow(r: DbRow): TrainingEvent {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    employeeId: String(r.employee_id),
    category: String(r.category) as TrainingCategory,
    description: String(r.description),
    provider: r.provider == null ? null : String(r.provider),
    nqfLevel: r.nqf_level == null ? null : Number(r.nqf_level),
    plannedStart: dateOrNull(r.planned_start),
    plannedEnd: dateOrNull(r.planned_end),
    actualStart: dateOrNull(r.actual_start),
    actualEnd: dateOrNull(r.actual_end),
    costPlanned: Number(r.cost_planned) || 0,
    costActual: Number(r.cost_actual) || 0,
    status: String(r.status) as TrainingStatus,
    notes: r.notes == null ? null : String(r.notes),
    createdBy: r.created_by == null ? null : String(r.created_by),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) throw new Error(`Employee ${employeeId} not in company`);
}

async function assertEventInCompany(companyId: string, id: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM training_events
     WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) throw new TrainingEventNotFoundError(id);
}

export interface CreateTrainingEventInput {
  companyId: string;
  employeeId: string;
  category: TrainingCategory;
  description: string;
  provider?: string;
  nqfLevel?: number;
  plannedStart?: string;
  plannedEnd?: string;
  costPlanned: number;
  notes?: string;
  userId: string;
}

export async function createTrainingEvent(input: CreateTrainingEventInput): Promise<TrainingEvent> {
  await assertEmployeeInCompany(input.companyId, input.employeeId);
  log.info(
    'Creating training event',
    { companyId: input.companyId, employeeId: input.employeeId, category: input.category },
    'trainingEventService',
  );
  const rows = (await sql`
    INSERT INTO training_events
      (company_id, employee_id, category, description, provider, nqf_level,
       planned_start, planned_end, cost_planned, notes, created_by)
    VALUES (
      ${input.companyId}::uuid, ${input.employeeId}::uuid,
      ${input.category}, ${input.description},
      ${input.provider ?? null}, ${input.nqfLevel ?? null},
      ${input.plannedStart ?? null}::date, ${input.plannedEnd ?? null}::date,
      ${input.costPlanned}, ${input.notes ?? null}, ${input.userId}
    )
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapRow(rows[0]);
}

export interface ListOptions {
  year?: number;
  employeeId?: string;
}

export async function listTrainingEvents(
  companyId: string,
  opts: ListOptions = {},
): Promise<TrainingEvent[]> {
  const rows = (await sql`
    SELECT te.*, e.first_name, e.last_name, e.employee_number
      FROM training_events te
      JOIN payroll_employees e ON e.id = te.employee_id
     WHERE te.company_id = ${companyId}::uuid
       AND (${opts.year ?? null}::int IS NULL
            OR (te.planned_start IS NOT NULL AND EXTRACT(YEAR FROM te.planned_start) = ${opts.year ?? null}::int))
       AND (${opts.employeeId ?? null}::uuid IS NULL OR te.employee_id = ${opts.employeeId ?? null}::uuid)
     ORDER BY te.planned_start DESC NULLS LAST, te.created_at DESC
  `) as DbRow[];
  return rows.map(mapRow);
}

export interface UpdateTrainingEventInput {
  category?: TrainingCategory;
  description?: string;
  provider?: string | null;
  nqfLevel?: number | null;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  actualStart?: string | null;
  actualEnd?: string | null;
  costPlanned?: number;
  costActual?: number;
  status?: TrainingStatus;
  notes?: string | null;
}

export async function updateTrainingEvent(
  companyId: string,
  id: string,
  input: UpdateTrainingEventInput,
): Promise<void> {
  await assertEventInCompany(companyId, id);
  await sql`
    UPDATE training_events SET
      category        = COALESCE(${input.category ?? null}::text, category),
      description     = COALESCE(${input.description ?? null}, description),
      provider        = COALESCE(${input.provider ?? null}, provider),
      nqf_level       = COALESCE(${input.nqfLevel ?? null}::int, nqf_level),
      planned_start   = COALESCE(${input.plannedStart ?? null}::date, planned_start),
      planned_end     = COALESCE(${input.plannedEnd ?? null}::date, planned_end),
      actual_start    = COALESCE(${input.actualStart ?? null}::date, actual_start),
      actual_end      = COALESCE(${input.actualEnd ?? null}::date, actual_end),
      cost_planned    = COALESCE(${input.costPlanned ?? null}::numeric, cost_planned),
      cost_actual     = COALESCE(${input.costActual ?? null}::numeric, cost_actual),
      status          = COALESCE(${input.status ?? null}::text, status),
      notes           = COALESCE(${input.notes ?? null}, notes),
      updated_at      = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;
}

export async function deleteTrainingEvent(companyId: string, id: string): Promise<void> {
  await assertEventInCompany(companyId, id);
  await sql`DELETE FROM training_events WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid`;
}

export interface WspAtrCategoryRow {
  category: TrainingCategory;
  count: number;
  totalPlanned: number;
  totalActual: number;
  byStatus: Record<TrainingStatus, number>;
}

export interface WspAtrReport {
  year: number;
  categories: WspAtrCategoryRow[];
  totals: {
    count: number;
    totalPlanned: number;
    totalActual: number;
  };
}

const STATUSES: TrainingStatus[] = ['planned', 'in_progress', 'completed', 'cancelled'];

export async function wspAtrReport(companyId: string, year: number): Promise<WspAtrReport> {
  const rows = (await sql`
    SELECT category,
           status,
           COUNT(*)::int AS count,
           COALESCE(SUM(cost_planned), 0) AS total_planned,
           COALESCE(SUM(cost_actual), 0)  AS total_actual
      FROM training_events
     WHERE company_id = ${companyId}::uuid
       AND planned_start IS NOT NULL
       AND EXTRACT(YEAR FROM planned_start) = ${year}::int
     GROUP BY category, status
     ORDER BY category, status
  `) as DbRow[];

  const byCategory = new Map<TrainingCategory, WspAtrCategoryRow>();
  for (const r of rows) {
    const cat = r.category as TrainingCategory;
    if (!byCategory.has(cat)) {
      byCategory.set(cat, {
        category: cat,
        count: 0,
        totalPlanned: 0,
        totalActual: 0,
        byStatus: STATUSES.reduce<Record<TrainingStatus, number>>(
          (acc, s) => ({ ...acc, [s]: 0 }),
          { planned: 0, in_progress: 0, completed: 0, cancelled: 0 },
        ),
      });
    }
    const bucket = byCategory.get(cat)!;
    const cnt = Number(r.count) || 0;
    bucket.count += cnt;
    bucket.totalPlanned += Number(r.total_planned) || 0;
    bucket.totalActual += Number(r.total_actual) || 0;
    const st = r.status as TrainingStatus;
    bucket.byStatus[st] = (bucket.byStatus[st] ?? 0) + cnt;
  }

  const categories = Array.from(byCategory.values());
  return {
    year,
    categories,
    totals: {
      count: categories.reduce((s, c) => s + c.count, 0),
      totalPlanned: categories.reduce((s, c) => s + c.totalPlanned, 0),
      totalActual: categories.reduce((s, c) => s + c.totalActual, 0),
    },
  };
}
