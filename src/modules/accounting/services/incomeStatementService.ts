/**
 * Income Statement (P&L) Service
 * Generates income statement reports from the general ledger.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { IncomeStatementReport } from '../types/gl.types';

type Row = Record<string, unknown>;

interface ReportLineItem {
  accountCode: string;
  accountName: string;
  amount: number;
}

interface ISOptions {
  projectId?: string;
  costCentreId?: string;
}

async function fetchIncomeStatementRows(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  opts: ISOptions
) {
  const projId = opts.projectId ?? null;
  const ccId = opts.costCentreId ?? null;

  const rows = (await sql`
    SELECT ga.account_code, ga.account_name, ga.account_type, ga.account_subtype,
      COALESCE(SUM(jl.debit), 0) AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
      AND ga.account_type IN ('revenue', 'expense')
      AND (${projId}::TEXT IS NULL OR jl.project_id = ${projId}::UUID)
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype
    ORDER BY ga.account_code
  `) as Row[];

  const revenue: ReportLineItem[] = [];
  const costOfSales: ReportLineItem[] = [];
  const operatingExpenses: ReportLineItem[] = [];

  for (const r of rows) {
    const type = String(r.account_type);
    const subtype = r.account_subtype ? String(r.account_subtype) : '';
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);

    if (type === 'revenue') {
      const amount = credit - debit;
      if (Math.abs(amount) > 0.001) {
        revenue.push({ accountCode: String(r.account_code), accountName: String(r.account_name), amount });
      }
    } else if (type === 'expense') {
      const amount = debit - credit;
      if (Math.abs(amount) > 0.001) {
        const item = { accountCode: String(r.account_code), accountName: String(r.account_name), amount };
        if (subtype === 'cost_of_sales') costOfSales.push(item);
        else operatingExpenses.push(item);
      }
    }
  }

  const totalRevenue = revenue.reduce((s, i) => s + i.amount, 0);
  const totalCostOfSales = costOfSales.reduce((s, i) => s + i.amount, 0);
  const grossProfit = totalRevenue - totalCostOfSales;
  const totalOperatingExpenses = operatingExpenses.reduce((s, i) => s + i.amount, 0);
  const netProfit = grossProfit - totalOperatingExpenses;

  return { revenue, costOfSales, operatingExpenses, totalRevenue, totalCostOfSales, grossProfit, totalOperatingExpenses, netProfit };
}

export async function getIncomeStatement(companyId: string,
  periodStart: string,
  periodEnd: string,
  opts: { projectId?: string; costCentreId?: string } = {},
  comparePeriod?: { start: string; end: string }
): Promise<IncomeStatementReport> {
  try {
    const [current, prior] = await Promise.all([
      fetchIncomeStatementRows(companyId, periodStart, periodEnd, opts),
      comparePeriod
        ? fetchIncomeStatementRows(companyId, comparePeriod.start, comparePeriod.end, opts)
        : Promise.resolve(null),
    ]);

    const report: IncomeStatementReport = {
      periodStart,
      periodEnd,
      projectId: opts.projectId,
      costCentreId: opts.costCentreId,
      revenue: current.revenue,
      costOfSales: current.costOfSales,
      operatingExpenses: current.operatingExpenses,
      totalRevenue: current.totalRevenue,
      totalCostOfSales: current.totalCostOfSales,
      grossProfit: current.grossProfit,
      totalOperatingExpenses: current.totalOperatingExpenses,
      netProfit: current.netProfit,
    };

    if (comparePeriod && prior) {
      report.comparativePeriod = comparePeriod;
      report.priorTotalRevenue = prior.totalRevenue;
      report.priorTotalCostOfSales = prior.totalCostOfSales;
      report.priorGrossProfit = prior.grossProfit;
      report.priorTotalOperatingExpenses = prior.totalOperatingExpenses;
      report.priorNetProfit = prior.netProfit;

      const mergeLineItems = (curr: ReportLineItem[], prev: ReportLineItem[]) => {
        const priorMap = new Map(prev.map(p => [p.accountCode, p.amount]));
        return curr.map(c => {
          const pa = priorMap.get(c.accountCode) ?? 0;
          const variance = c.amount - pa;
          return { ...c, priorAmount: pa, variance, variancePct: pa !== 0 ? (variance / Math.abs(pa)) * 100 : 0 };
        });
      };
      report.revenue = mergeLineItems(current.revenue, prior.revenue);
      report.costOfSales = mergeLineItems(current.costOfSales, prior.costOfSales);
      report.operatingExpenses = mergeLineItems(current.operatingExpenses, prior.operatingExpenses);
    }

    return report;
  } catch (err) {
    log.error('Failed to generate income statement', { error: err }, 'accounting');
    throw err;
  }
}
