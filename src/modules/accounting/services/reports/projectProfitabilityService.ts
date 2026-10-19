/**
 * Project Profitability Service
 * Generates per-project P&L reports from the general ledger.
 *
 * TWO PROJECT BASES, side by side (Hein, 2026-10-10). A line can name a
 * project two ways, and they are different id spaces:
 *   - `jobs` (the DEFAULT): `jl.project_id`, a `projects` row — the job that
 *     invoice lines, WIP and time read. Exactly the report this always was.
 *   - `cc2`: `jl.cc2_id`, a CC2 cost centre (dimensions plan: CC2 = project,
 *     parent = its CC1). The project id is the cost-centre id and the name is
 *     "<code> — <name>".
 * A caller picks one; the two are never mixed or COALESCEd. Whether CC2
 * replaces jobs is still open. Every table is read with this company's id: the
 * dimension columns carry no tenant-pair FK, so a legacy line can name another
 * company's row, and an unscoped join would print its name — an unowned id
 * keeps its bucket, unnamed.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ProjectProfitabilityReport } from '../../types/gl.types';
import type { DbRow } from '@/types/db';
import type { ProjectBasis } from './projectBasis';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';


interface ReportLineItem {
  accountCode: string;
  accountName: string;
  amount: number;
}

/**
 * How much of the period's P&L is tagged to a project (on the chosen basis) at all.
 *
 * The report shows only tagged lines, which is correct — but on its own it
 * makes an untagged ledger look like a company with no projects. On the books
 * this was written against, ZERO of 39,285 journal lines across four companies
 * carried a project_id, so the report returned an empty array that read as
 * "nothing to see". This is the denominator that turns that into a finding:
 * "R<x> of P&L movement is tagged to no project".
 */
export interface ProjectTaggingCoverage {
  taggedLines: number;
  untaggedLines: number;
  /** P&L movement on untagged lines, at the same sign convention as the report. */
  untaggedAmount: number;
  /** MAX(created_at) of the journal lines consumed, ISO-8601, or null. */
  postedThrough: string | null;
}

export async function getProjectTaggingCoverage(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  basis: ProjectBasis = 'jobs',
): Promise<ProjectTaggingCoverage> {
  // The tag column is chosen by a CASE over a bound value, never by
  // interpolating an identifier.
  const [row] = (await sql`
    WITH lines AS (
      SELECT CASE ${basis}::TEXT WHEN 'cc2' THEN jl.cc2_id ELSE jl.project_id END AS tag,
             ga.account_type, jl.debit, jl.credit, jl.created_at
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
      WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND ga.account_type IN ('revenue', 'expense')
    )
    SELECT
      COUNT(*) FILTER (WHERE tag IS NOT NULL) AS tagged_lines,
      COUNT(*) FILTER (WHERE tag IS NULL) AS untagged_lines,
      COALESCE(SUM(
        CASE WHEN tag IS NULL THEN
          CASE WHEN account_type = 'revenue' THEN credit - debit ELSE debit - credit END
        ELSE 0 END
      ), 0) AS untagged_amount,
      MAX(created_at) AS posted_through
    FROM lines
  `) as DbRow[];

  return {
    taggedLines: Number(row?.tagged_lines ?? 0),
    untaggedLines: Number(row?.untagged_lines ?? 0),
    untaggedAmount: Number(row?.untagged_amount ?? 0),
    postedThrough: row?.posted_through ? new Date(String(row.posted_through)).toISOString() : null,
  };
}

/** One project's report from its account rows (revenue and expense only). */
function toReport(
  projectId: string, projectName: string, rows: readonly DbRow[], periodStart: string, periodEnd: string,
): ProjectProfitabilityReport {
  const revenueLines: ReportLineItem[] = [];
  const costLines: ReportLineItem[] = [];
  for (const r of rows) {
    const type = String(r.account_type);
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);
    const amount = type === 'revenue' ? credit - debit : debit - credit;
    if (Math.abs(amount) <= 0.001) continue;
    const item = { accountCode: String(r.account_code), accountName: String(r.account_name), amount };
    if (type === 'revenue') revenueLines.push(item);
    else if (type === 'expense') costLines.push(item);
  }
  const revenue = revenueLines.reduce((s, r) => s + r.amount, 0);
  const costs = costLines.reduce((s, c) => s + c.amount, 0);
  const profit = revenue - costs;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  return {
    projectId, projectName, periodStart, periodEnd, revenue, costs, profit,
    margin: Math.round(margin * 100) / 100, revenueLines, costLines,
  };
}

/** Jobs basis: every job with posted movement in the window, as this report has always listed them. */
async function jobReports(companyId: string, periodStart: string, periodEnd: string) {
  const projectRows = (await sql`
    SELECT DISTINCT jl.project_id, p.name AS project_name
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    LEFT JOIN projects p ON p.id = jl.project_id AND p.company_id = ${companyId}::UUID
    WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
      AND jl.project_id IS NOT NULL
    ORDER BY p.name
  `) as DbRow[];

  const reports: ProjectProfitabilityReport[] = [];
  for (const proj of projectRows) {
    const projectId = String(proj.project_id);
    const rows = (await sql`
      SELECT ga.account_code, ga.account_name, ga.account_type,
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
      WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND jl.project_id = ${projectId}::UUID
        AND ga.account_type IN ('revenue', 'expense')
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type
      ORDER BY ga.account_code
    `) as DbRow[];
    const name = proj.project_name ? String(proj.project_name) : 'Unknown Project';
    reports.push(toReport(projectId, name, rows, periodStart, periodEnd));
  }
  return reports;
}

/** CC2 basis: one grouped query over project × account. */
async function cc2Reports(companyId: string, periodStart: string, periodEnd: string) {
  const rows = (await sql`
    SELECT jl.cc2_id AS project_id, cc.code AS project_code, cc.name AS project_name,
      ga.account_code, ga.account_name, ga.account_type,
      COALESCE(SUM(jl.debit), 0) AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    LEFT JOIN cost_centres cc ON cc.id = jl.cc2_id AND cc.company_id = ${companyId}::UUID
    WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
      AND jl.cc2_id IS NOT NULL
      AND ga.account_type IN ('revenue', 'expense')
    GROUP BY jl.cc2_id, cc.code, cc.name, ga.id, ga.account_code, ga.account_name, ga.account_type
    ORDER BY ga.account_code
  `) as DbRow[];

  const byProject = new Map<string, { name: string; rows: DbRow[] }>();
  for (const r of rows) {
    const id = String(r.project_id);
    const proj = byProject.get(id)
      ?? { name: r.project_code ? `${String(r.project_code)} — ${String(r.project_name)}` : 'Unknown Project', rows: [] };
    proj.rows.push(r);
    byProject.set(id, proj);
  }
  return [...byProject].map(([id, p]) => toReport(id, p.name, p.rows, periodStart, periodEnd));
}

/** Per-project P&L on the chosen basis (default `jobs`), most profitable first. */
export async function getProjectProfitability(companyId: string,
  periodStart: string,
  periodEnd: string,
  basis: ProjectBasis = 'jobs',
): Promise<ProjectProfitabilityReport[]> {
  try {
    const reports = basis === 'cc2'
      ? await cc2Reports(companyId, periodStart, periodEnd)
      : await jobReports(companyId, periodStart, periodEnd);
    reports.sort((a, b) => b.profit - a.profit);
    return reports;
  } catch (err) {
    log.error('Failed to generate project profitability', { error: err, basis }, 'accounting');
    throw err;
  }
}
