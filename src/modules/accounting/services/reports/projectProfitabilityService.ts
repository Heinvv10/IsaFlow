/**
 * Project Profitability Service
 * Generates per-project P&L reports from the general ledger.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ProjectProfitabilityReport } from '../../types/gl.types';
import type { DbRow } from '@/types/db';


interface ReportLineItem {
  accountCode: string;
  accountName: string;
  amount: number;
}

/**
 * How much of the period's P&L is tagged to a project (CC2) at all.
 *
 * The project dimension is `gl_journal_lines.cc2_id` (migration 285; the
 * dimensions plan made CC2 = project, parent = its CC1). The legacy
 * `project_id` column is carried by no line on these books — ZERO of 39,285
 * across four companies when this was first measured — so a report keyed on it
 * returned an empty array that read as "nothing to see". This is the
 * denominator that turns an empty or thin report into a finding: "R<x> of P&L
 * movement is tagged to no project".
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
): Promise<ProjectTaggingCoverage> {
  const [row] = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE jl.cc2_id IS NOT NULL) AS tagged_lines,
      COUNT(*) FILTER (WHERE jl.cc2_id IS NULL) AS untagged_lines,
      COALESCE(SUM(
        CASE WHEN jl.cc2_id IS NULL THEN
          CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
               ELSE jl.debit - jl.credit END
        ELSE 0 END
      ), 0) AS untagged_amount,
      MAX(jl.created_at) AS posted_through
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
      AND ga.account_type IN ('revenue', 'expense')
  `) as DbRow[];

  return {
    taggedLines: Number(row?.tagged_lines ?? 0),
    untaggedLines: Number(row?.untagged_lines ?? 0),
    untaggedAmount: Number(row?.untagged_amount ?? 0),
    postedThrough: row?.posted_through ? new Date(String(row.posted_through)).toISOString() : null,
  };
}

/**
 * Per-project (CC2) P&L. One grouped query over project × account — the
 * previous shape ran one query per project.
 *
 * `projectId` is the CC2 cost-centre id and `projectName` is "<code> — <name>".
 * The cost centre is joined within the company: the dimension columns carry no
 * FK on gl_journal_lines, so a legacy line can name another company's row, and
 * an unscoped join would print that company's name here. An unowned id keeps
 * its bucket, unnamed.
 */
export async function getProjectProfitability(companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<ProjectProfitabilityReport[]> {
  try {
    const rows = (await sql`
      SELECT jl.cc2_id AS project_id, cc.code AS project_code, cc.name AS project_name,
        ga.account_code, ga.account_name, ga.account_type,
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      LEFT JOIN cost_centres cc ON cc.id = jl.cc2_id AND cc.company_id = jl.company_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND jl.cc2_id IS NOT NULL
        AND ga.account_type IN ('revenue', 'expense')
      GROUP BY jl.cc2_id, cc.code, cc.name, ga.id, ga.account_code, ga.account_name, ga.account_type
      ORDER BY ga.account_code
    `) as DbRow[];

    const byProject = new Map<string, {
      projectName: string; revenueLines: ReportLineItem[]; costLines: ReportLineItem[];
    }>();

    for (const r of rows) {
      const projectId = String(r.project_id);
      let proj = byProject.get(projectId);
      if (!proj) {
        const projectName = r.project_code
          ? `${String(r.project_code)} — ${String(r.project_name)}`
          : 'Unknown Project';
        proj = { projectName, revenueLines: [], costLines: [] };
        byProject.set(projectId, proj);
      }
      const type = String(r.account_type);
      const debit = Number(r.total_debit);
      const credit = Number(r.total_credit);
      const amount = type === 'revenue' ? credit - debit : debit - credit;
      if (Math.abs(amount) <= 0.001) continue;
      const item = { accountCode: String(r.account_code), accountName: String(r.account_name), amount };
      if (type === 'revenue') proj.revenueLines.push(item);
      else proj.costLines.push(item);
    }

    const reports: ProjectProfitabilityReport[] = [];
    for (const [projectId, proj] of byProject) {
      const revenue = proj.revenueLines.reduce((s, r) => s + r.amount, 0);
      const costs = proj.costLines.reduce((s, c) => s + c.amount, 0);
      const profit = revenue - costs;
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
      reports.push({
        projectId,
        projectName: proj.projectName,
        periodStart,
        periodEnd,
        revenue,
        costs,
        profit,
        margin: Math.round(margin * 100) / 100,
        revenueLines: proj.revenueLines,
        costLines: proj.costLines,
      });
    }

    reports.sort((a, b) => b.profit - a.profit);
    return reports;
  } catch (err) {
    log.error('Failed to generate project profitability', { error: err }, 'accounting');
    throw err;
  }
}
