// src/modules/accounting/services/afs/afsKpiService.ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { KpiResult, KpiScorecard, FinancialSnapshot, RagThresholds } from './afsTypes';
import { marginPct } from '../reports/marginPct';
import { CASH_SUBTYPES } from '../gl/accountSubtypes';

export type { FinancialSnapshot, RagThresholds };

type Row = DbRow;

export const DEFAULT_RAG_THRESHOLDS: RagThresholds = {
  grossMarginPct:     { green: 40,     amber: 20,    lowerIsBetter: false },
  ebitdaMarginPct:    { green: 15,     amber: 5,     lowerIsBetter: false },
  netProfitMarginPct: { green: 10,     amber: 5,     lowerIsBetter: false },
  currentRatio:       { green: 1.5,    amber: 1.0,   lowerIsBetter: false },
  quickRatio:         { green: 1.0,    amber: 0.7,   lowerIsBetter: false },
  debtorDays:         { green: 30,     amber: 60,    lowerIsBetter: true  },
  creditorDays:       { green: 45,     amber: 75,    lowerIsBetter: true  },
  cashConversionCycle:{ green: 30,     amber: 60,    lowerIsBetter: true  },
  debtToEquity:       { green: 1.0,    amber: 2.0,   lowerIsBetter: true  },
  revenueGrowthPct:   { green: 10,     amber: 0,     lowerIsBetter: false },
  cashBurnRate:       { green: 0,      amber: 50000, lowerIsBetter: true  },
};

function safeDiv(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

function computeRag(
  value: number,
  thresholds: { green: number; amber: number; lowerIsBetter: boolean },
): 'green' | 'amber' | 'red' {
  if (thresholds.lowerIsBetter) {
    if (value <= thresholds.green) return 'green';
    if (value <= thresholds.amber) return 'amber';
    return 'red';
  }
  if (value >= thresholds.green) return 'green';
  if (value >= thresholds.amber) return 'amber';
  return 'red';
}

function computeTrend(value: number, priorValue: number | null): 'up' | 'down' | 'flat' {
  if (priorValue === null) return 'flat';
  if (priorValue === 0) return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const pct = Math.abs((value - priorValue) / priorValue);
  if (pct < 0.01) return 'flat';
  return value > priorValue ? 'up' : 'down';
}

function formatKpi(key: string, value: number): string {
  const pctKeys = ['grossMarginPct', 'ebitdaMarginPct', 'netProfitMarginPct', 'revenueGrowthPct'];
  const ratioKeys = ['currentRatio', 'quickRatio', 'debtToEquity'];
  const dayKeys = ['debtorDays', 'creditorDays', 'cashConversionCycle'];

  if (pctKeys.includes(key)) return `${value.toFixed(1)}%`;
  if (ratioKeys.includes(key)) return value.toFixed(2);
  if (dayKeys.includes(key)) return `${value.toFixed(0)}d`;
  return `R${value.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;
}

const KPI_LABELS: Record<string, string> = {
  grossMarginPct:     'Gross Margin',
  ebitdaMarginPct:    'EBITDA Margin',
  netProfitMarginPct: 'Net Profit Margin',
  currentRatio:       'Current Ratio',
  quickRatio:         'Quick Ratio',
  debtorDays:         'Debtor Days',
  creditorDays:       'Creditor Days',
  cashConversionCycle:'Cash Conversion Cycle',
  debtToEquity:       'Debt to Equity',
  revenueGrowthPct:   'Revenue Growth',
  cashBurnRate:       'Cash Burn Rate',
};

function makeKpi(
  key: string,
  value: number,
  priorValue: number | null,
  thresholds: RagThresholds,
  denomWasZero = false,
): KpiResult {
  const rag = denomWasZero ? 'red' : computeRag(value, thresholds[key] ?? { green: 0, amber: 0, lowerIsBetter: false });
  return {
    key,
    label: KPI_LABELS[key] ?? key,
    value,
    formatted: formatKpi(key, value),
    rag,
    trend: computeTrend(value, priorValue),
    priorValue,
  };
}

export function calculateKpis(
  current: FinancialSnapshot,
  prior: FinancialSnapshot | null,
  ragThresholds: RagThresholds,
): KpiResult[] {
  const { revenue, cogs, grossProfit, ebitda, netProfit, currentAssets,
    currentLiabilities, inventory, tradeReceivables, tradePayables,
    totalDebt, totalEquity, openingCash, closingCash, daysInPeriod } = current;

  // `?? 0` at the call site: these KPIs have always reported 0 on no revenue
  // and the RAG bands are calibrated on that. `allowNegativeRevenue` holds the
  // other half of the pre-existing behaviour still — this service guarded
  // `revenue === 0` and computed through a negative. See marginPct.ts.
  const NEG = { allowNegativeRevenue: true };
  const grossMarginPct     = marginPct(grossProfit, revenue, NEG) ?? 0;
  const ebitdaMarginPct    = marginPct(ebitda, revenue, NEG) ?? 0;
  const netProfitMarginPct = marginPct(netProfit, revenue, NEG) ?? 0;
  const currentRatio       = safeDiv(currentAssets, currentLiabilities);
  const quickRatio         = safeDiv(currentAssets - inventory, currentLiabilities);
  const debtorDays         = revenue === 0 ? 0 : safeDiv(tradeReceivables, revenue) * daysInPeriod;
  const creditorDays       = cogs === 0 ? 0 : safeDiv(tradePayables, cogs) * daysInPeriod;
  const cashConversionCycle= debtorDays - creditorDays;
  const debtToEquity       = safeDiv(totalDebt, totalEquity);
  const priorRevenue       = prior?.revenue ?? null;
  const revenueGrowthPct   = (priorRevenue === null || priorRevenue === 0)
    ? 0
    : safeDiv(revenue - priorRevenue, priorRevenue) * 100;
  const cashChange = closingCash - openingCash;
  const cashBurnRate = cashChange < 0
    ? safeDiv(Math.abs(cashChange), daysInPeriod) * 30
    : 0;

  return [
    makeKpi('grossMarginPct',     grossMarginPct,     prior ? safeDiv(prior.grossProfit, prior.revenue) * 100 : null, ragThresholds, revenue === 0),
    makeKpi('ebitdaMarginPct',    ebitdaMarginPct,    prior ? safeDiv(prior.ebitda, prior.revenue) * 100 : null,      ragThresholds, revenue === 0),
    makeKpi('netProfitMarginPct', netProfitMarginPct, prior ? safeDiv(prior.netProfit, prior.revenue) * 100 : null,   ragThresholds, revenue === 0),
    makeKpi('currentRatio',       currentRatio,       prior ? safeDiv(prior.currentAssets, prior.currentLiabilities) : null, ragThresholds, currentLiabilities === 0),
    makeKpi('quickRatio',         quickRatio,         prior ? safeDiv(prior.currentAssets - prior.inventory, prior.currentLiabilities) : null, ragThresholds, currentLiabilities === 0),
    makeKpi('debtorDays',         debtorDays,         prior ? safeDiv(prior.tradeReceivables, prior.revenue) * prior.daysInPeriod : null, ragThresholds, revenue === 0),
    makeKpi('creditorDays',       creditorDays,       prior ? safeDiv(prior.tradePayables, prior.cogs) * prior.daysInPeriod : null, ragThresholds, cogs === 0),
    makeKpi('cashConversionCycle',cashConversionCycle,prior ? (safeDiv(prior.tradeReceivables, prior.revenue) * prior.daysInPeriod) - (safeDiv(prior.tradePayables, prior.cogs) * prior.daysInPeriod) : null, ragThresholds),
    makeKpi('debtToEquity',       debtToEquity,       prior ? safeDiv(prior.totalDebt, prior.totalEquity) : null, ragThresholds, totalEquity === 0),
    makeKpi('revenueGrowthPct',   revenueGrowthPct,   null, ragThresholds, priorRevenue === 0),
    makeKpi('cashBurnRate',       cashBurnRate,       null, ragThresholds),
  ];
}

function periodBounds(period: string): { start: string; end: string; days: number } {
  const parts = period.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end, days: lastDay };
}

function priorPeriod(period: string): string {
  const parts = period.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, '0')}`;
}

async function fetchIncomeSnapshot(companyId: string, periodStart: string, periodEnd: string): Promise<Pick<FinancialSnapshot, 'revenue' | 'cogs' | 'grossProfit' | 'ebitda' | 'ebit' | 'netProfit'>> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'cost_of_sales' THEN jl.debit - jl.credit ELSE 0 END), 0) AS cogs,
      COALESCE(SUM(CASE
        WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
        WHEN ga.account_type = 'expense' THEN -(jl.debit - jl.credit)
        ELSE 0 END), 0) AS net_profit,
      COALESCE(SUM(CASE
        WHEN ga.account_type = 'expense' AND ga.account_subtype = 'depreciation_expense'
        THEN jl.debit - jl.credit ELSE 0 END), 0) AS depreciation
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${periodStart}::date
      AND je.entry_date <= ${periodEnd}::date
  `) as Row[];

  const row = rows[0] ?? {};
  const revenue     = Number(row.revenue ?? 0);
  const cogs        = Number(row.cogs ?? 0);
  const netProfit   = Number(row.net_profit ?? 0);
  const depreciation= Number(row.depreciation ?? 0);
  const grossProfit = revenue - cogs;
  const ebit        = netProfit;
  const ebitda      = ebit + depreciation;
  return { revenue, cogs, grossProfit, ebitda, ebit, netProfit };
}

async function fetchBalanceSnapshot(companyId: string, periodEnd: string): Promise<Pick<FinancialSnapshot, 'currentAssets' | 'currentLiabilities' | 'inventory' | 'tradeReceivables' | 'tradePayables' | 'totalDebt' | 'totalEquity'>> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_type = 'asset' AND ga.account_subtype NOT IN ('fixed_asset','accumulated_depreciation') THEN jl.debit - jl.credit ELSE 0 END), 0) AS current_assets,
      COALESCE(SUM(CASE WHEN ga.account_type = 'liability' THEN jl.credit - jl.debit ELSE 0 END), 0) AS current_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_type = 'asset' AND ga.account_subtype = 'inventory' THEN jl.debit - jl.credit ELSE 0 END), 0) AS inventory,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'receivable' THEN jl.debit - jl.credit ELSE 0 END), 0) AS trade_receivables,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'payable' THEN jl.credit - jl.debit ELSE 0 END), 0) AS trade_payables,
      COALESCE(SUM(CASE WHEN ga.account_type = 'liability' THEN jl.credit - jl.debit ELSE 0 END), 0) AS total_debt,
      COALESCE(SUM(CASE WHEN ga.account_type = 'equity' THEN jl.credit - jl.debit ELSE 0 END), 0) AS total_equity
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${periodEnd}::date
  `) as Row[];

  const row = rows[0] ?? {};
  return {
    currentAssets:      Number(row.current_assets ?? 0),
    currentLiabilities: Number(row.current_liabilities ?? 0),
    inventory:          Number(row.inventory ?? 0),
    tradeReceivables:   Number(row.trade_receivables ?? 0),
    tradePayables:      Number(row.trade_payables ?? 0),
    totalDebt:          Number(row.total_debt ?? 0),
    totalEquity:        Number(row.total_equity ?? 0),
  };
}

/**
 * Opening cash, on the SAME definition the cash-flow statement uses.
 *
 * The literal `account_subtype = 'bank'` missed petty cash (subtype `cash`) and
 * counted a credit card spelled `bank_account` as cash, so the KPI block and the
 * cash-flow reconciliation printed beside it in the same AFS export disagreed by
 * exactly those balances. `CASH_SUBTYPES` plus `account_type = 'asset'` is the
 * definition `cashBalanceService`, `cashFlowDirectService` and
 * `cashFlowReconciliationService` all carry.
 */
async function fetchCash(companyId: string, beforeDate: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
    ), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = ANY(${CASH_SUBTYPES as string[]})
      AND ga.account_type = 'asset'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date < ${beforeDate}::date
  `) as Row[];

  return Number(rows[0]?.balance ?? 0);
}

async function fetchClosingCash(companyId: string, upToDate: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
    ), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = ANY(${CASH_SUBTYPES as string[]})
      AND ga.account_type = 'asset'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${upToDate}::date
  `) as Row[];

  return Number(rows[0]?.balance ?? 0);
}

async function buildSnapshot(companyId: string, period: string): Promise<FinancialSnapshot> {
  const { start, end, days } = periodBounds(period);
  const [income, balance, openingCash, closingCash] = await Promise.all([
    fetchIncomeSnapshot(companyId, start, end),
    fetchBalanceSnapshot(companyId, end),
    fetchCash(companyId, start),
    fetchClosingCash(companyId, end),
  ]);
  return { ...income, ...balance, openingCash, closingCash, daysInPeriod: days };
}

export async function getKpiScorecard(
  companyId: string,
  period: string,
  ragThresholds: RagThresholds = DEFAULT_RAG_THRESHOLDS,
): Promise<KpiScorecard> {
  log.info('Computing KPI scorecard', { companyId, period }, 'kpiScorecardService');

  const prior = priorPeriod(period);
  const [currentSnap, priorSnap] = await Promise.all([
    buildSnapshot(companyId, period),
    buildSnapshot(companyId, prior),
  ]);

  const kpis = calculateKpis(currentSnap, priorSnap, ragThresholds);

  return {
    period,
    companyId,
    kpis,
    generatedAt: new Date().toISOString(),
  };
}
