/**
 * Time Tracking Service
 * Billable hours and project time management
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

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

function mapEntry(r: Row): TimeEntry {
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

/**
 * Helper: call sql as a parameterized query string.
 * The neon() function supports sql(queryString, params[]) in addition to tagged templates.
 */
async function query(text: string, params: unknown[]): Promise<Row[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sql as any)(text, params) as Promise<Row[]>;
}

export async function getTimeEntries(
  _companyId: string,
  filters?: {
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
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;

  const conditions: string[] = ['te.company_id = $1::UUID'];
  const params: unknown[] = [_companyId];
  let idx = 2;

  if (filters?.userId) {
    conditions.push(`te.user_id = $${idx}`);
    params.push(filters.userId);
    idx++;
  }
  if (filters?.customerId) {
    conditions.push(`te.customer_id = $${idx}::UUID`);
    params.push(filters.customerId);
    idx++;
  }
  if (filters?.projectName) {
    conditions.push(`te.project_name ILIKE $${idx}`);
    params.push(`%${filters.projectName}%`);
    idx++;
  }
  if (filters?.status) {
    conditions.push(`te.status = $${idx}`);
    params.push(filters.status);
    idx++;
  }
  if (filters?.billable !== undefined) {
    conditions.push(`te.billable = $${idx}`);
    params.push(filters.billable);
    idx++;
  }
  if (filters?.dateFrom) {
    conditions.push(`te.entry_date >= $${idx}::DATE`);
    params.push(filters.dateFrom);
    idx++;
  }
  if (filters?.dateTo) {
    conditions.push(`te.entry_date <= $${idx}::DATE`);
    params.push(filters.dateTo);
    idx++;
  }

  const where = conditions.join(' AND ');

  const countRows = await query(
    `SELECT COUNT(*) AS cnt FROM time_entries te WHERE ${where}`,
    params,
  );

  const rows = await query(
    `SELECT te.*, c.company_name AS customer_name
     FROM time_entries te
     LEFT JOIN clients c ON c.id = te.customer_id
     WHERE ${where}
     ORDER BY te.entry_date DESC, te.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset],
  );

  return {
    entries: rows.map(mapEntry),
    total: Number(countRows[0]?.cnt || 0),
  };
}

export async function getTimeEntry(
  _companyId: string,
  id: string,
): Promise<TimeEntry | null> {
  const rows = (await sql`
    SELECT te.*, c.company_name AS customer_name
    FROM time_entries te
    LEFT JOIN clients c ON c.id = te.customer_id
    WHERE te.id = ${id}::UUID AND te.company_id = ${_companyId}::UUID
  `) as Row[];
  if (!rows.length) return null;
  return mapEntry(rows[0]);
}

export async function createTimeEntry(
  _companyId: string,
  input: TimeEntryInput,
  userId: string,
): Promise<TimeEntry> {
  const entryDate = input.entryDate || new Date().toISOString().split('T')[0];
  const rows = (await sql`
    INSERT INTO time_entries (
      company_id, user_id, project_name, task_description, entry_date,
      hours, rate, billable, customer_id, notes
    ) VALUES (
      ${_companyId}::UUID, ${userId}::UUID, ${input.projectName || null},
      ${input.taskDescription}, ${entryDate}::DATE,
      ${input.hours}, ${input.rate ?? null},
      ${input.billable !== false}, ${input.customerId || null}::UUID,
      ${input.notes || null}
    ) RETURNING *
  `) as Row[];

  log.info('Created time entry', { id: rows[0]?.id, userId }, 'accounting');
  return mapEntry(rows[0]!);
}

export async function updateTimeEntry(
  _companyId: string,
  id: string,
  input: Partial<TimeEntryInput>,
): Promise<TimeEntry> {
  const existing = (await sql`
    SELECT status FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${_companyId}::UUID
  `) as Row[];
  if (!existing.length) throw new Error('Time entry not found');
  if (existing[0].status !== 'draft') throw new Error('Only draft entries can be edited');

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
    WHERE id = ${id}::UUID AND company_id = ${_companyId}::UUID
    RETURNING *
  `) as Row[];

  log.info('Updated time entry', { id }, 'accounting');
  return mapEntry(rows[0]!);
}

export async function deleteTimeEntry(
  _companyId: string,
  id: string,
): Promise<void> {
  const existing = (await sql`
    SELECT status FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${_companyId}::UUID
  `) as Row[];
  if (!existing.length) throw new Error('Time entry not found');
  if (existing[0].status !== 'draft') throw new Error('Only draft entries can be deleted');

  await sql`
    DELETE FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${_companyId}::UUID
  `;
  log.info('Deleted time entry', { id }, 'accounting');
}

export async function submitEntries(
  _companyId: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const result = (await sql`
    UPDATE time_entries SET status = 'submitted', updated_at = NOW()
    WHERE company_id = ${_companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'draft'
  `) as Row[];
  const count = Array.isArray(result) ? result.length : 0;
  log.info('Submitted time entries', { count, ids }, 'accounting');
  return count;
}

export async function approveEntries(
  _companyId: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const result = (await sql`
    UPDATE time_entries SET status = 'approved', updated_at = NOW()
    WHERE company_id = ${_companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'submitted'
  `) as Row[];
  const count = Array.isArray(result) ? result.length : 0;
  log.info('Approved time entries', { count, ids }, 'accounting');
  return count;
}

export async function getTimeSummary(
  _companyId: string,
  filters?: { dateFrom?: string; dateTo?: string; userId?: string },
): Promise<TimeSummary> {
  // Build conditions for summary queries
  const conditions: string[] = ['company_id = $1::UUID'];
  const params: unknown[] = [_companyId];
  let idx = 2;

  if (filters?.dateFrom) {
    conditions.push(`entry_date >= $${idx}::DATE`);
    params.push(filters.dateFrom);
    idx++;
  }
  if (filters?.dateTo) {
    conditions.push(`entry_date <= $${idx}::DATE`);
    params.push(filters.dateTo);
    idx++;
  }
  if (filters?.userId) {
    conditions.push(`user_id = $${idx}`);
    params.push(filters.userId);
    idx++;
  }

  const where = conditions.join(' AND ');

  const totals = await query(
    `SELECT
       COALESCE(SUM(hours), 0) AS total_hours,
       COALESCE(SUM(CASE WHEN billable THEN hours ELSE 0 END), 0) AS billable_hours,
       COALESCE(SUM(CASE WHEN NOT billable THEN hours ELSE 0 END), 0) AS non_billable_hours,
       COALESCE(SUM(CASE WHEN billable AND rate IS NOT NULL THEN hours * rate ELSE 0 END), 0) AS total_value
     FROM time_entries WHERE ${where}`,
    params,
  );

  const byProject = await query(
    `SELECT
       COALESCE(project_name, 'Unassigned') AS project_name,
       SUM(hours) AS hours,
       COALESCE(SUM(CASE WHEN rate IS NOT NULL THEN hours * rate ELSE 0 END), 0) AS value
     FROM time_entries WHERE ${where}
     GROUP BY COALESCE(project_name, 'Unassigned')
     ORDER BY hours DESC`,
    params,
  );

  // For the customer join query, prefix columns with te.
  const teWhere = where
    .replace(/company_id/g, 'te.company_id')
    .replace(/entry_date/g, 'te.entry_date')
    .replace(/user_id/g, 'te.user_id');

  const byCustomer = await query(
    `SELECT
       COALESCE(te.customer_id::TEXT, 'none') AS customer_id,
       COALESCE(c.company_name, 'No Customer') AS customer_name,
       SUM(te.hours) AS hours,
       COALESCE(SUM(CASE WHEN te.rate IS NOT NULL THEN te.hours * te.rate ELSE 0 END), 0) AS value
     FROM time_entries te
     LEFT JOIN clients c ON c.id = te.customer_id
     WHERE ${teWhere}
     GROUP BY COALESCE(te.customer_id::TEXT, 'none'), COALESCE(c.company_name, 'No Customer')
     ORDER BY hours DESC`,
    params,
  );

  const t = totals[0] || {};
  return {
    totalHours: Number(t.total_hours || 0),
    billableHours: Number(t.billable_hours || 0),
    nonBillableHours: Number(t.non_billable_hours || 0),
    totalValue: Number(t.total_value || 0),
    byProject: byProject.map((r: Row) => ({
      projectName: String(r.project_name),
      hours: Number(r.hours),
      value: Number(r.value),
    })),
    byCustomer: byCustomer.map((r: Row) => ({
      customerId: String(r.customer_id),
      customerName: String(r.customer_name),
      hours: Number(r.hours),
      value: Number(r.value),
    })),
  };
}

export async function getUninvoicedEntries(
  _companyId: string,
  customerId?: string,
): Promise<TimeEntry[]> {
  let rows: Row[];
  if (customerId) {
    rows = (await sql`
      SELECT te.*, c.company_name AS customer_name
      FROM time_entries te
      LEFT JOIN clients c ON c.id = te.customer_id
      WHERE te.company_id = ${_companyId}::UUID
        AND te.status = 'approved'
        AND te.billable = true
        AND te.invoiced = false
        AND te.customer_id = ${customerId}::UUID
      ORDER BY te.entry_date ASC
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT te.*, c.company_name AS customer_name
      FROM time_entries te
      LEFT JOIN clients c ON c.id = te.customer_id
      WHERE te.company_id = ${_companyId}::UUID
        AND te.status = 'approved'
        AND te.billable = true
        AND te.invoiced = false
      ORDER BY te.entry_date ASC
    `) as Row[];
  }
  return rows.map(mapEntry);
}

export async function markAsInvoiced(
  _companyId: string,
  entryIds: string[],
  invoiceId: string,
): Promise<number> {
  if (!entryIds.length) return 0;
  const result = (await sql`
    UPDATE time_entries SET
      invoiced = true,
      invoice_id = ${invoiceId}::UUID,
      status = 'invoiced',
      updated_at = NOW()
    WHERE company_id = ${_companyId}::UUID
      AND id = ANY(${entryIds}::UUID[])
      AND status = 'approved'
      AND billable = true
  `) as Row[];
  const count = Array.isArray(result) ? result.length : 0;
  log.info('Marked time entries as invoiced', { count, invoiceId }, 'accounting');
  return count;
}
