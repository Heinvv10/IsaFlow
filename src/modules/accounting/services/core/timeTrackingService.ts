/**
 * Time Tracking Service
 * Billable hours and project time management
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';


export interface TimeEntry {
  id: string;
  companyId: string;
  userId: string;
  projectName: string | null;
  taskDescription: string;
  entryDate: string;
  hours: number;
  rate: number | null;
  amount: number | null;
  billable: boolean;
  invoiced: boolean;
  invoiceId: string | null;
  customerId: string | null;
  customerName: string | null;
  notes: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimeEntryInput {
  projectName?: string;
  taskDescription: string;
  entryDate?: string;
  hours: number;
  rate?: number;
  billable?: boolean;
  customerId?: string;
  notes?: string;
}

export interface TimeSummary {
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  totalValue: number;
  byProject: { projectName: string; hours: number; value: number }[];
  byCustomer: { customerId: string; customerName: string; hours: number; value: number }[];
}

function mapEntry(r: DbRow): TimeEntry {
  const hours = Number(r.hours || 0);
  const rate = r.rate != null ? Number(r.rate) : null;
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    projectName: r.project_name ? String(r.project_name) : null,
    taskDescription: String(r.task_description),
    entryDate: String(r.entry_date),
    hours,
    rate,
    amount: rate != null ? hours * rate : null,
    billable: Boolean(r.billable),
    invoiced: Boolean(r.invoiced),
    invoiceId: r.invoice_id ? String(r.invoice_id) : null,
    customerId: r.customer_id ? String(r.customer_id) : null,
    customerName: r.customer_name ? String(r.customer_name) : null,
    notes: r.notes ? String(r.notes) : null,
    status: String(r.status),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function getTimeEntries(
  companyId: string,
  _filters?: {
    userId?: string;
    customerId?: string;
    projectName?: string;
    status?: string;
    billable?: boolean;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ entries: TimeEntry[]; total: number }> {
  const lim = _filters?.limit || 50;
  const off = _filters?.offset || 0;

  try {
    const countRows = (await sql`
      SELECT COUNT(*)::int AS cnt FROM time_entries WHERE company_id = ${companyId}::UUID
    `) as DbRow[];

    const rows = (await sql`
      SELECT te.*, c.name AS customer_name
      FROM time_entries te
      LEFT JOIN customers c ON c.id = te.customer_id
      WHERE te.company_id = ${companyId}::UUID
      ORDER BY te.entry_date DESC, te.created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `) as DbRow[];

    return {
      entries: rows.map(mapEntry),
      total: Number(countRows[0]?.cnt || 0),
    };
  } catch (err) {
    log.error('getTimeEntries failed', { error: err instanceof Error ? err.message : String(err) }, 'time-tracking');
    return { entries: [], total: 0 };
  }
}

export async function getTimeEntry(
  companyId: string,
  id: string,
): Promise<TimeEntry | null> {
  const rows = (await sql`
    SELECT te.*, c.name AS customer_name
    FROM time_entries te
    LEFT JOIN customers c ON c.id = te.customer_id
    WHERE te.id = ${id}::UUID AND te.company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!rows.length) return null;
  return mapEntry(rows[0]!);
}

export async function createTimeEntry(
  companyId: string,
  input: TimeEntryInput,
  userId: string,
): Promise<TimeEntry> {
  const entryDate = input.entryDate || new Date().toISOString().split('T')[0];
  const rows = (await sql`
    INSERT INTO time_entries (
      company_id, user_id, project_name, task_description, entry_date,
      hours, rate, billable, customer_id, notes
    ) VALUES (
      ${companyId}::UUID, ${userId}::UUID, ${input.projectName || null},
      ${input.taskDescription}, ${entryDate}::DATE,
      ${input.hours}, ${input.rate ?? null},
      ${input.billable !== false}, ${input.customerId || null}::UUID,
      ${input.notes || null}
    ) RETURNING *
  `) as DbRow[];

  log.info('Created time entry', { id: rows[0]?.id, userId }, 'accounting');
  return mapEntry(rows[0]!);
}

export async function updateTimeEntry(
  companyId: string,
  id: string,
  input: Partial<TimeEntryInput>,
): Promise<TimeEntry> {
  const existing = (await sql`
    SELECT status FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('Time entry not found');
  if (String(existing[0]!.status) !== 'draft') throw new Error('Only draft entries can be edited');

  const rows = (await sql`
    UPDATE time_entries SET
      project_name = COALESCE(${input.projectName ?? null}, project_name),
      task_description = COALESCE(${input.taskDescription ?? null}, task_description),
      entry_date = COALESCE(${input.entryDate ?? null}::DATE, entry_date),
      hours = COALESCE(${input.hours ?? null}, hours),
      rate = COALESCE(${input.rate ?? null}, rate),
      billable = COALESCE(${input.billable ?? null}, billable),
      customer_id = COALESCE(${input.customerId ?? null}::UUID, customer_id),
      notes = COALESCE(${input.notes ?? null}, notes),
      updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];

  log.info('Updated time entry', { id }, 'accounting');
  return mapEntry(rows[0]!);
}

export async function deleteTimeEntry(
  companyId: string,
  id: string,
): Promise<void> {
  const existing = (await sql`
    SELECT status FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('Time entry not found');
  if (String(existing[0]!.status) !== 'draft') throw new Error('Only draft entries can be deleted');

  await sql`
    DELETE FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Deleted time entry', { id }, 'accounting');
}

export async function submitEntries(
  companyId: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const result = (await sql`
    UPDATE time_entries SET status = 'submitted', updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'draft'
    RETURNING id
  `) as DbRow[];
  const count = result.length;
  log.info('Submitted time entries', { count, ids }, 'accounting');
  return count;
}

export async function approveEntries(
  companyId: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const result = (await sql`
    -- approved_at: the date WIP is measured from (practice/wipAsOf). This path
    -- used to leave it NULL, so an as-of WIP report could not tell when these
    -- entries were approved; the practice approval path has always set it.
    UPDATE time_entries SET status = 'approved', approved_at = NOW(), updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'submitted'
    RETURNING id
  `) as DbRow[];
  const count = result.length;
  log.info('Approved time entries', { count, ids }, 'accounting');
  return count;
}

// Report operations (summary, uninvoiced, markAsInvoiced) — re-exported from split file
export { getTimeSummary, getUninvoicedEntries, markAsInvoiced } from '../reports/timeTrackingReportService';
