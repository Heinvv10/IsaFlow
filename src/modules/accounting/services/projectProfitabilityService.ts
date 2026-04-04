/**
 * Project Profitability Service
 * Generates per-project P&L reports from the general ledger.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ProjectProfitabilityReport } from '../types/gl.types';

type Row = Record<string, unknown>;

interface ReportLineItem {
  accountCode: string;
  accountName: string;
  amount: number;
}

export async function getProjectProfitability(companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<ProjectProfitabilityReport[]> {
  try {
    const projectRows = (await sql`
      SELECT DISTINCT jl.project_id, p.project_name
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      LEFT JOIN projects p ON p.id = jl.project_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND jl.project_id IS NOT NULL
      ORDER BY p.project_name
    `) as Row[];

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
          AND je.entry_date >= ${periodStart}
          AND je.entry_date <= ${periodEnd}
          AND jl.project_id = ${projectId}::UUID
          AND ga.account_type IN ('revenue', 'expense')
        GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type
        ORDER BY ga.account_code
      `) as Row[];

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
