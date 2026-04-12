/**
 * Time Tracking Report Service
 * Summary, uninvoiced entries, and mark-as-invoiced operations.
 * Split from timeTrackingService.ts to keep both files ≤300 lines.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { TimeEntry, TimeSummary } from './timeTrackingService';

type Row = Record<string, unknown>;

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

export async function getTimeSummary(
  companyId: string,
  _filters?: { dateFrom?: string; dateTo?: string; userId?: string },
): Promise<TimeSummary> {
  try {
    const totals = (await sql`
      SELECT
        COALESCE(SUM(hours), 0) AS total_hours,
        COALESCE(SUM(CASE WHEN billable THEN hours ELSE 0 END), 0) AS billable_hours,
        COALESCE(SUM(CASE WHEN NOT billable THEN hours ELSE 0 END), 0) AS non_billable_hours,
        COALESCE(SUM(CASE WHEN billable AND rate IS NOT NULL THEN hours * rate ELSE 0 END), 0) AS total_value
      FROM time_entries WHERE company_id = ${companyId}::UUID
    `) as Row[];

    const byProject = (await sql`
      SELECT
        COALESCE(project_name, 'Unassigned') AS project_name,
        SUM(hours) AS hours,
        COALESCE(SUM(CASE WHEN rate IS NOT NULL THEN hours * rate ELSE 0 END), 0) AS value
      FROM time_entries WHERE company_id = ${companyId}::UUID
      GROUP BY COALESCE(project_name, 'Unassigned')
      ORDER BY hours DESC
    `) as Row[];

    const byCustomer = (await sql`
      SELECT
        COALESCE(te.customer_id::TEXT, 'none') AS customer_id,
        COALESCE(c.name, 'No Customer') AS customer_name,
        SUM(te.hours) AS hours,
        COALESCE(SUM(CASE WHEN te.rate IS NOT NULL THEN te.hours * te.rate ELSE 0 END), 0) AS value
      FROM time_entries te
      LEFT JOIN customers c ON c.id = te.customer_id
      WHERE te.company_id = ${companyId}::UUID
      GROUP BY COALESCE(te.customer_id::TEXT, 'none'), COALESCE(c.name, 'No Customer')
      ORDER BY hours DESC
    `) as Row[];

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
  } catch (err) {
    log.error('getTimeSummary failed', { error: err instanceof Error ? err.message : String(err) }, 'time-tracking');
    return { totalHours: 0, billableHours: 0, nonBillableHours: 0, totalValue: 0, byProject: [], byCustomer: [] };
  }
}

export async function getUninvoicedEntries(
  companyId: string,
  customerId?: string,
): Promise<TimeEntry[]> {
  let rows: Row[];
  if (customerId) {
    rows = (await sql`
      SELECT te.*, c.name AS customer_name
      FROM time_entries te
      LEFT JOIN customers c ON c.id = te.customer_id
      WHERE te.company_id = ${companyId}::UUID
        AND te.status = 'approved'
        AND te.billable = true
        AND te.invoiced = false
        AND te.customer_id = ${customerId}::UUID
      ORDER BY te.entry_date ASC
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT te.*, c.name AS customer_name
      FROM time_entries te
      LEFT JOIN customers c ON c.id = te.customer_id
      WHERE te.company_id = ${companyId}::UUID
        AND te.status = 'approved'
        AND te.billable = true
        AND te.invoiced = false
      ORDER BY te.entry_date ASC
    `) as Row[];
  }
  return rows.map(mapEntry);
}

export async function markAsInvoiced(
  companyId: string,
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
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${entryIds}::UUID[])
      AND status = 'approved'
      AND billable = true
  `) as Row[];
  const count = Array.isArray(result) ? result.length : 0;
  log.info('Marked time entries as invoiced', { count, invoiceId }, 'accounting');
  return count;
}
