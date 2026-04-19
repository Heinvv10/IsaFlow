import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface UtilisationRow {
  userId: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  billableValue: number;
  utilisationPct: number; // 0-100
}

export interface ProfitabilityRow {
  practiceClientId: string;
  legalName: string;
  revenue: number;
  hours: number;
  timeCost: number | null; // null in MVP
  margin: number | null;    // null in MVP
  marginPct: number | null; // null in MVP
}

export interface WipAgingRow {
  practiceClientId: string;
  legalName: string;
  total: number;
  bucket0to7: number;
  bucket8to14: number;
  bucket15to30: number;
  bucket31plus: number;
}

export interface PipelineSummary {
  totalApproved: number;
  totalInvoicedLast30d: number;
  forecast30d: number;
  asOfDate: string;
}

export interface ComplianceRow {
  userId: string;
  expectedDays: number;
  submittedDays: number;
  missingDays: string[]; // 'YYYY-MM-DD'
  status: 'compliant' | 'partial' | 'missing';
}

export interface ServiceMixRow {
  jobCategoryId: string;
  name: string;
  hours: number;
  value: number;
  pct: number; // 0-100, 2 decimals
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().split('T')[0]!;
}

function weekdays(start: string, end: string): string[] {
  const dates: string[] = [];
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  for (let d = new Date(s); d <= e; d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) dates.push(d.toISOString().split('T')[0]!);
  }
  return dates;
}

// ─── Functions ────────────────────────────────────────────────────────────────

export async function getStaffUtilisation(
  companyId: string,
  input: { dateFrom: string; dateTo: string; userId?: string },
): Promise<UtilisationRow[]> {
  const { dateFrom, dateTo } = input;
  const userId = input.userId ?? null;

  const rows = (await sql`
    SELECT te.user_id,
           SUM(te.hours)::NUMERIC AS total_hours,
           SUM(CASE WHEN te.billable THEN te.hours ELSE 0 END)::NUMERIC AS billable_hours,
           SUM(CASE WHEN te.billable THEN COALESCE(te.line_total, 0) ELSE 0 END)::NUMERIC AS billable_value
    FROM time_entries te
    WHERE te.company_id = ${companyId}::UUID
      AND te.entry_date BETWEEN ${dateFrom}::DATE AND ${dateTo}::DATE
      AND te.practice_client_id IS NOT NULL
      AND (${userId}::UUID IS NULL OR te.user_id = ${userId}::UUID)
    GROUP BY te.user_id
  `) as DbRow[];

  return rows.map((r) => {
    const totalHours = Number(r.total_hours);
    const billableHours = Number(r.billable_hours);
    const nonBillableHours = totalHours - billableHours;
    const billableValue = Number(r.billable_value);
    const utilisationPct =
      totalHours > 0 ? Math.round((billableHours / totalHours) * 10000) / 100 : 0;
    return {
      userId: String(r.user_id),
      totalHours,
      billableHours,
      nonBillableHours,
      billableValue,
      utilisationPct,
    };
  });
}

export async function getClientProfitability(
  companyId: string,
  input: { dateFrom: string; dateTo: string; practiceClientId?: string },
): Promise<ProfitabilityRow[]> {
  const { dateFrom, dateTo } = input;
  const clientId = input.practiceClientId ?? null;

  const rows = (await sql`
    SELECT te.practice_client_id,
           pc.legal_name,
           SUM(CASE WHEN te.status = 'billed' THEN COALESCE(te.line_total, 0) ELSE 0 END)::NUMERIC AS revenue,
           SUM(te.hours)::NUMERIC AS hours
    FROM time_entries te
    JOIN practice_clients pc ON pc.id = te.practice_client_id
    WHERE te.company_id = ${companyId}::UUID
      AND te.entry_date BETWEEN ${dateFrom}::DATE AND ${dateTo}::DATE
      AND (${clientId}::UUID IS NULL OR te.practice_client_id = ${clientId}::UUID)
    GROUP BY te.practice_client_id, pc.legal_name
    ORDER BY revenue DESC
  `) as DbRow[];

  return rows.map((r) => ({
    practiceClientId: String(r.practice_client_id),
    legalName: String(r.legal_name),
    revenue: Number(r.revenue),
    hours: Number(r.hours),
    timeCost: null,
    margin: null,
    marginPct: null,
  }));
}

export async function getWipAging(
  companyId: string,
  input: { asOfDate?: string },
): Promise<WipAgingRow[]> {
  const asOfDate = input.asOfDate ?? todayString();

  const rows = (await sql`
    SELECT te.practice_client_id,
           pc.legal_name,
           SUM(te.line_total)::NUMERIC AS total,
           SUM(CASE WHEN ${asOfDate}::DATE - te.approved_at::DATE BETWEEN 0 AND 7
                    THEN te.line_total ELSE 0 END)::NUMERIC AS bucket_0_7,
           SUM(CASE WHEN ${asOfDate}::DATE - te.approved_at::DATE BETWEEN 8 AND 14
                    THEN te.line_total ELSE 0 END)::NUMERIC AS bucket_8_14,
           SUM(CASE WHEN ${asOfDate}::DATE - te.approved_at::DATE BETWEEN 15 AND 30
                    THEN te.line_total ELSE 0 END)::NUMERIC AS bucket_15_30,
           SUM(CASE WHEN ${asOfDate}::DATE - te.approved_at::DATE > 30
                    THEN te.line_total ELSE 0 END)::NUMERIC AS bucket_31_plus
    FROM time_entries te
    JOIN practice_clients pc ON pc.id = te.practice_client_id
    WHERE te.company_id = ${companyId}::UUID
      AND te.status = 'approved'
      AND te.billed_at IS NULL
      AND te.billable = true
      AND te.line_total IS NOT NULL
    GROUP BY te.practice_client_id, pc.legal_name
    ORDER BY total DESC
  `) as DbRow[];

  log.info('getWipAging', { companyId, asOfDate, count: rows.length }, 'practice');

  return rows.map((r) => ({
    practiceClientId: String(r.practice_client_id),
    legalName: String(r.legal_name),
    total: Number(r.total),
    bucket0to7: Number(r.bucket_0_7),
    bucket8to14: Number(r.bucket_8_14),
    bucket15to30: Number(r.bucket_15_30),
    bucket31plus: Number(r.bucket_31_plus),
  }));
}

export async function getRevenuePipeline(
  companyId: string,
  input: { asOfDate?: string },
): Promise<PipelineSummary> {
  const asOfDate = input.asOfDate ?? todayString();

  const [approvedRows, invoicedRows] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(line_total), 0) AS v
      FROM time_entries
      WHERE company_id = ${companyId}::UUID
        AND status = 'approved'
        AND billed_at IS NULL
        AND billable = true
    ` as Promise<DbRow[]>,
    sql`
      SELECT COALESCE(SUM(line_total), 0) AS v
      FROM time_entries
      WHERE company_id = ${companyId}::UUID
        AND billed_at IS NOT NULL
        AND billed_at >= ${asOfDate}::DATE - INTERVAL '30 days'
    ` as Promise<DbRow[]>,
  ]);

  const totalApproved = Number((approvedRows as DbRow[])[0]?.['v'] ?? 0);
  const totalInvoicedLast30d = Number((invoicedRows as DbRow[])[0]?.['v'] ?? 0);
  const forecast30d = Math.round(totalApproved * 0.8 * 100) / 100;

  log.info('getRevenuePipeline', { companyId, asOfDate, totalApproved, totalInvoicedLast30d }, 'practice');

  return { totalApproved, totalInvoicedLast30d, forecast30d, asOfDate };
}

export async function getComplianceReport(
  companyId: string,
  input: { periodStart: string; periodEnd: string },
): Promise<ComplianceRow[]> {
  const { periodStart, periodEnd } = input;

  const userRows = (await sql`
    SELECT DISTINCT user_id FROM time_entries
    WHERE company_id = ${companyId}::UUID AND practice_client_id IS NOT NULL
  `) as DbRow[];

  if (!userRows.length) return [];

  const expected = weekdays(periodStart, periodEnd);
  const results: ComplianceRow[] = [];

  for (const u of userRows) {
    const userId = String(u.user_id);
    const submittedRows = (await sql`
      SELECT DISTINCT entry_date::TEXT AS d FROM time_entries
      WHERE company_id = ${companyId}::UUID
        AND user_id = ${userId}::UUID
        AND entry_date BETWEEN ${periodStart}::DATE AND ${periodEnd}::DATE
        AND status <> 'draft'
    `) as DbRow[];

    const submitted = new Set(submittedRows.map((r) => String(r.d)));
    const missingDays = expected.filter((d) => !submitted.has(d));
    const submittedDays = expected.length - missingDays.length;
    const status: ComplianceRow['status'] =
      submittedDays === expected.length
        ? 'compliant'
        : submittedDays === 0
          ? 'missing'
          : 'partial';

    results.push({ userId, expectedDays: expected.length, submittedDays, missingDays, status });
  }

  log.info('getComplianceReport', { companyId, periodStart, periodEnd, userCount: results.length }, 'practice');

  return results;
}

export async function getServiceMix(
  companyId: string,
  input: { dateFrom: string; dateTo: string },
): Promise<ServiceMixRow[]> {
  const { dateFrom, dateTo } = input;

  const rows = (await sql`
    SELECT te.job_category_id,
           pjc.name,
           SUM(te.hours)::NUMERIC AS hours,
           SUM(COALESCE(te.line_total, 0))::NUMERIC AS value
    FROM time_entries te
    JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
    WHERE te.company_id = ${companyId}::UUID
      AND te.entry_date BETWEEN ${dateFrom}::DATE AND ${dateTo}::DATE
      AND te.practice_client_id IS NOT NULL
    GROUP BY te.job_category_id, pjc.name
    ORDER BY value DESC
  `) as DbRow[];

  log.info('getServiceMix', { companyId, dateFrom, dateTo, count: rows.length }, 'practice');

  const totalValue = rows.reduce((s, r) => s + Number(r.value), 0);

  return rows.map((r) => ({
    jobCategoryId: String(r.job_category_id),
    name: String(r.name),
    hours: Number(r.hours),
    value: Number(r.value),
    pct: totalValue > 0 ? Math.round((Number(r.value) / totalValue) * 10000) / 100 : 0,
  }));
}
