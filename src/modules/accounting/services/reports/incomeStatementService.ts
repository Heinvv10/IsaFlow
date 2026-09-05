/**
 * Income Statement (P&L) Service
 * Generates income statement reports from the general ledger.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { IncomeStatementReport } from '../../types/gl.types';
import type { DbRow } from '@/types/db';
import {
  expenseBand,
  revenueBand,
} from '@/modules/accounting/services/gl/accountClassification';
import {
  buildIncomeStatementSubtypeDisclosure,
  type DisclosureInputRow,
} from './incomeStatementDisclosure';


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
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
      AND ga.account_type IN ('revenue', 'expense')
      AND (${projId}::TEXT IS NULL OR jl.project_id = ${projId}::UUID)
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype
    ORDER BY ga.account_code
  `) as DbRow[];

  const revenue: ReportLineItem[] = [];
  const otherIncome: ReportLineItem[] = [];
  const costOfSales: ReportLineItem[] = [];
  const operatingExpenses: ReportLineItem[] = [];
  const otherExpenses: ReportLineItem[] = [];
  // Collected in the SAME loop that bands the lines, from the same rows over
  // the same period, so the disclosure cannot disagree with the totals it sits
  // under. See ./incomeStatementDisclosure.ts.
  const disclosureRows: DisclosureInputRow[] = [];

  for (const r of rows) {
    const type = String(r.account_type);
    const subtype = r.account_subtype ? String(r.account_subtype) : '';
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);

    const accountCode = String(r.account_code);
    const accountName = String(r.account_name);

    // Bands come from `accountClassification`, the same functions
    // `aggregateFigures` uses. Deciding them here independently is what made
    // the two surfaces report different gross profits (B75).
    if (type === 'revenue') {
      const amount = credit - debit;
      if (Math.abs(amount) > 0.001) {
        const item = { accountCode, accountName, amount };
        if (revenueBand(subtype) === 'other_income') otherIncome.push(item);
        else revenue.push(item);
        disclosureRows.push({ accountCode, accountName, accountType: 'revenue', accountSubtype: subtype, amount });
      }
    } else if (type === 'expense') {
      const amount = debit - credit;
      if (Math.abs(amount) > 0.001) {
        const item = { accountCode, accountName, amount };
        switch (expenseBand(subtype)) {
          case 'cost_of_sales': costOfSales.push(item); break;
          case 'other_expense': otherExpenses.push(item); break;
          default: operatingExpenses.push(item); break;
        }
        disclosureRows.push({ accountCode, accountName, accountType: 'expense', accountSubtype: subtype, amount });
      }
    }
  }

  const totalRevenue = revenue.reduce((s, i) => s + i.amount, 0);
  const totalOtherIncome = otherIncome.reduce((s, i) => s + i.amount, 0);
  const totalCostOfSales = costOfSales.reduce((s, i) => s + i.amount, 0);
  const totalOperatingExpenses = operatingExpenses.reduce((s, i) => s + i.amount, 0);
  const totalOtherExpenses = otherExpenses.reduce((s, i) => s + i.amount, 0);

  // Gross profit is TRADING only — turnover less cost of sales. Other income is
  // not trading revenue and must not reach it.
  const grossProfit = totalRevenue - totalCostOfSales;
  // Operating profit puts other income ABOVE the line and finance cost and tax
  // below it, matching `aggregateFigures` and `profit_and_loss`'s shipped
  // description. An earlier cut of this file excluded other income here, which
  // simply moved the B75 divergence from gross profit onto a line this change
  // introduced — the same defect one row down.
  const operatingProfit = grossProfit + totalOtherIncome - totalOperatingExpenses;
  // Net profit is unchanged by the split, to the cent: every figure that moved
  // was already inside the bottom line, just in the wrong band. That invariant
  // is what makes this a reclassification rather than a restatement.
  const netProfit = operatingProfit - totalOtherExpenses;

  // The two margins the screen used to derive for itself. They are ratios of
  // service figures and belong with the figures: the 96.6% gross margin a
  // reader took off this statement was wrong because of how the bands were
  // built, and a component deriving its own version hides that from every
  // other surface. Null rather than 0 when there is no turnover — a margin on
  // no revenue is undefined, not zero.
  const grossMarginPct = totalRevenue !== 0 ? (grossProfit / totalRevenue) * 100 : null;
  const netMarginPct = totalRevenue !== 0 ? (netProfit / totalRevenue) * 100 : null;

  return {
    revenue, otherIncome, costOfSales, operatingExpenses, otherExpenses,
    totalRevenue, totalOtherIncome, totalCostOfSales,
    totalOperatingExpenses, totalOtherExpenses,
    grossProfit, operatingProfit, netProfit,
    grossMarginPct, netMarginPct,
    subtypeDisclosure: buildIncomeStatementSubtypeDisclosure(disclosureRows),
  };
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
      otherIncome: current.otherIncome,
      costOfSales: current.costOfSales,
      operatingExpenses: current.operatingExpenses,
      otherExpenses: current.otherExpenses,
      totalRevenue: current.totalRevenue,
      totalOtherIncome: current.totalOtherIncome,
      totalCostOfSales: current.totalCostOfSales,
      totalOperatingExpenses: current.totalOperatingExpenses,
      totalOtherExpenses: current.totalOtherExpenses,
      grossProfit: current.grossProfit,
      operatingProfit: current.operatingProfit,
      netProfit: current.netProfit,
      grossMarginPct: current.grossMarginPct,
      netMarginPct: current.netMarginPct,
      subtypeDisclosure: current.subtypeDisclosure,
    };

    if (comparePeriod && prior) {
      report.comparativePeriod = comparePeriod;
      report.priorTotalRevenue = prior.totalRevenue;
      report.priorTotalOtherIncome = prior.totalOtherIncome;
      report.priorTotalCostOfSales = prior.totalCostOfSales;
      report.priorGrossProfit = prior.grossProfit;
      report.priorOperatingProfit = prior.operatingProfit;
      report.priorTotalOperatingExpenses = prior.totalOperatingExpenses;
      report.priorTotalOtherExpenses = prior.totalOtherExpenses;
      report.priorNetProfit = prior.netProfit;
      // The prior period has its own unclassified mix, so every variance
      // column is a difference between two differently-banded numbers. One
      // banner over the current period reads as though it qualified both.
      report.priorSubtypeDisclosure = prior.subtypeDisclosure;

      const mergeLineItems = (curr: ReportLineItem[], prev: ReportLineItem[]) => {
        const priorMap = new Map(prev.map(p => [p.accountCode, p.amount]));
        return curr.map(c => {
          const pa = priorMap.get(c.accountCode) ?? 0;
          const variance = c.amount - pa;
          return { ...c, priorAmount: pa, variance, variancePct: pa !== 0 ? (variance / Math.abs(pa)) * 100 : 0 };
        });
      };
      report.revenue = mergeLineItems(current.revenue, prior.revenue);
      report.otherIncome = mergeLineItems(current.otherIncome, prior.otherIncome);
      report.costOfSales = mergeLineItems(current.costOfSales, prior.costOfSales);
      report.operatingExpenses = mergeLineItems(current.operatingExpenses, prior.operatingExpenses);
      report.otherExpenses = mergeLineItems(current.otherExpenses, prior.otherExpenses);
    }

    return report;
  } catch (err) {
    log.error('Failed to generate income statement', { error: err }, 'accounting');
    throw err;
  }
}
