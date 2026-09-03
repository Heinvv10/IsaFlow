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
 * How much of the period's P&L is tagged to a project at all.
 *
 * `getProjectProfitability` reports only journal lines carrying a project_id,
 * which is correct — but on its own it makes an untagged ledger look like a
 * company with no projects. On the books this was written against, ZERO of
 * 39,285 journal lines across four companies carry a project_id and there are
 * no project rows at all, so the report returns an empty array that reads as
 * "nothing to see". This is the denominator that turns that into a finding:
 * the report can say "R<x> of P&L movement is tagged to no project".
 */
export interface ProjectTaggingCoverage {
  taggedLines: number;
  untaggedLines: number;
  /** Absolute P&L movement on untagged lines, at the same sign convention as the report. */
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
      COUNT(*) FILTER (WHERE jl.project_id IS NOT NULL) AS tagged_lines,
      COUNT(*) FILTER (WHERE jl.project_id IS NULL) AS untagged_lines,
      COALESCE(SUM(
        CASE WHEN jl.project_id IS NULL THEN
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

export async function getProjectProfitability(companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<ProjectProfitabilityReport[]> {
  try {
    const projectRows = (await sql`
      SELECT DISTINCT jl.project_id, p.name AS project_name
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      LEFT JOIN projects p ON p.id = jl.project_id
      WHERE je.status = 'posted'
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
      const projectName = proj.project_name ? String(proj.project_name) : 'Unknown Project';

      const rows = (await sql`
        SELECT ga.account_code, ga.account_name, ga.account_type,
          COALESCE(SUM(jl.debit), 0) AS total_debit,
          COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${periodStart}
          AND je.entry_date <= ${periodEnd}
          AND jl.project_id = ${projectId}::UUID
          AND ga.account_type IN ('revenue', 'expense')
        GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type
        ORDER BY ga.account_code
      `) as DbRow[];

      const revenueLines: ReportLineItem[] = [];
      const costLines: ReportLineItem[] = [];

      for (const r of rows) {
        const type = String(r.account_type);
        const debit = Number(r.total_debit);
        const credit = Number(r.total_credit);

        if (type === 'revenue') {
          const amount = credit - debit;
          if (Math.abs(amount) > 0.001) {
            revenueLines.push({ accountCode: String(r.account_code), accountName: String(r.account_name), amount });
          }
        } else if (type === 'expense') {
          const amount = debit - credit;
          if (Math.abs(amount) > 0.001) {
            costLines.push({ accountCode: String(r.account_code), accountName: String(r.account_name), amount });
          }
        }
      }

      const revenue = revenueLines.reduce((s, r) => s + r.amount, 0);
      const costs = costLines.reduce((s, c) => s + c.amount, 0);
      const profit = revenue - costs;
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

      reports.push({
        projectId,
        projectName,
        periodStart,
        periodEnd,
        revenue,
        costs,
        profit,
        margin: Math.round(margin * 100) / 100,
        revenueLines,
        costLines,
      });
    }

    reports.sort((a, b) => b.profit - a.profit);
    return reports;
  } catch (err) {
    log.error('Failed to generate project profitability', { error: err }, 'accounting');
    throw err;
  }
}
