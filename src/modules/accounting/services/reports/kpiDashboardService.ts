/**
 * KPI Dashboard Service — Core Financial KPIs
 * Revenue, expenses, cash, receivables, payables, and activity metrics.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { marginPct } from './marginPct';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';
import { todayInSast } from '@/lib/saDateParser';
import { getOpenBook, type OpenBook } from './dashboardOpenBook';
import { revenueBand } from '../gl/accountClassification';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';


export interface DashboardKPIs {
  revenue: { total: number; priorTotal: number; changePercent: number };
  /** Posted revenue from the 1st of the current SAST month to `todayStr`: the hero's "Revenue MTD". */
  revenueMtd: number;
  expenses: { total: number; priorTotal: number };
  /**
   * Every revenue-type account less every expense: the income statement's Net Profit. `margin` is over
   * turnover and null with no positive turnover: a dash, not 0.0% and not a ratio of two negatives.
   */
  netProfit: { amount: number; margin: number | null };
  cash: { total: number; priorTotal: number; change: number };
  receivables: { total: number; overdue: number; overdueDisputed: number; avgDebtorDays: number };
  payables: { total: number; overdue: number; avgCreditorDays: number };
  activity: { invoicesIssued: number; paymentsReceived: number; journalsPosted: number };
}

/** One row per revenue-account subtype: the P&L bands by subtype, so the KPIs do too. */
type RevenueRow = { account_subtype?: string | null; total?: unknown };
const sumRevenue = (rows: RevenueRow[]): number => rows.reduce((s, r) => s + Number(r.total || 0), 0);
const turnover = (rows: RevenueRow[]): number =>
  sumRevenue(rows.filter((r) => revenueBand(r.account_subtype) === 'turnover'));

/** Both sides of the open book, already read: a caller that also draws the ageing donuts reads each once. */
export interface OpenBooks { ar: OpenBook; ap: OpenBook }

/**
 * `todayStr` is the SAST app date the Receivables / Payables tiles are as at
 * (reports/dashboardOpenBook), never the UTC session's CURRENT_DATE. `books`
 * are those tiles' open books when the caller already has them; without them
 * they are read here.
 */
export async function getDashboardKPIs(companyId: string,
  fromDate: string,
  toDate: string,
  todayStr: string = todayInSast(),
  books?: OpenBooks,
): Promise<DashboardKPIs> {
  try {
    const from = new Date(fromDate);
    const to = new Date(toDate);
    const durationMs = to.getTime() - from.getTime();
    const priorFrom = new Date(from.getTime() - durationMs);
    const priorFromStr = priorFrom.toISOString().slice(0, 10);
    const priorToStr = new Date(from.getTime() - 86400000).toISOString().slice(0, 10);

    const [
      revenueRows, priorRevenueRows,
      expenseRows, priorExpenseRows,
      cashRows, priorCashRows,
      arBook, arDebtorDaysRows,
      apBook, apCreditorDaysRows,
      invoicesIssuedRows, paymentsReceivedRows, journalsPostedRows,
      mtdRevenueRows,
    ] = await Promise.all([
      sql`
        SELECT ga.account_subtype, COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
          AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${fromDate} AND je.entry_date <= ${toDate}
        GROUP BY ga.account_subtype
      `,
      sql`
        SELECT ga.account_subtype, COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
          AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${priorFromStr} AND je.entry_date <= ${priorToStr}
        GROUP BY ga.account_subtype
      `,
      sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        WHERE ga.account_type = 'expense' AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
          AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${fromDate} AND je.entry_date <= ${toDate}
      `,
      sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        WHERE ga.account_type = 'expense' AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
          AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${priorFromStr} AND je.entry_date <= ${priorToStr}
      `,
      sql`
        SELECT COALESCE(SUM(bt.amount), 0) AS total
        FROM bank_transactions bt
        JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        -- No is_active filter: is_active is a chart-of-accounts picker flag,
        -- not a statement about whether the account still holds money.
        -- Deactivating a bank account must not make its cash disappear.
        -- Latent, not benign: the delta is R0 today only because no inactive
        -- bank account currently holds a bank_transactions row. Deactivate
        -- 1049686 Brighttech Absa and R1,911,554.82 of cash leaves this figure
        -- silently. Do not reinstate the filter because the change looks
        -- like a no-op.
        WHERE ga.account_subtype = ANY(${BANK_SUBTYPES as string[]})
          AND bt.company_id = ${companyId}::UUID
          AND bt.feed_state = 'posted'
      `,
      sql`
        SELECT COALESCE(SUM(bt.amount), 0) AS total
        FROM bank_transactions bt
        JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        -- No is_active filter: is_active is a chart-of-accounts picker flag,
        -- not a statement about whether the account still holds money.
        -- Deactivating a bank account must not make its cash disappear.
        -- Latent, not benign: the delta is R0 today only because no inactive
        -- bank account currently holds a bank_transactions row. Deactivate
        -- 1049686 Brighttech Absa and R1,911,554.82 of cash leaves this figure
        -- silently. Do not reinstate the filter because the change looks
        -- like a no-op.
        WHERE ga.account_subtype = ANY(${BANK_SUBTYPES as string[]})
          AND bt.company_id = ${companyId}::UUID
          AND bt.feed_state = 'posted'
          AND bt.transaction_date <= ${priorToStr}
      `,
      // The aging report's own population, as at todayStr; its soft-delete
      // presence is dated there too (K-053, shared/softDeleteLedgerPresence).
      books ? books.ar : getOpenBook(companyId, 'ar', todayStr),
      sql`
        SELECT COALESCE(AVG(
          EXTRACT(EPOCH FROM (COALESCE(paid_at, CURRENT_DATE) - invoice_date)) / 86400
        ), 0) AS avg_days
        FROM customer_invoices
        WHERE status NOT IN ('cancelled', 'draft')
          AND company_id = ${companyId}::UUID
          AND invoice_date >= ${fromDate}
      `,
      books ? books.ap : getOpenBook(companyId, 'ap', todayStr),
      sql`
        SELECT COALESCE(AVG(
          EXTRACT(EPOCH FROM (COALESCE(paid_at, CURRENT_DATE) - invoice_date)) / 86400
        ), 0) AS avg_days
        FROM supplier_invoices
        WHERE status NOT IN ('cancelled', 'draft')
          AND company_id = ${companyId}::UUID
          AND invoice_date >= ${fromDate}
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM customer_invoices
        WHERE company_id = ${companyId}::UUID
          AND invoice_date >= ${fromDate} AND invoice_date <= ${toDate}
          AND status NOT IN ('cancelled', 'draft')
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM customer_invoices
        WHERE company_id = ${companyId}::UUID
          AND paid_at >= ${fromDate} AND paid_at <= ${toDate}
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM gl_journal_entries
        WHERE company_id = ${companyId}::UUID
          AND status = 'posted' AND source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
          AND entry_date >= ${fromDate} AND entry_date <= ${toDate}
      `,
      // The revenue tile's own rule, over the SAST month so far (the tile
      // spans the whole window and is not a month-to-date figure).
      sql`
        SELECT ga.account_subtype, COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
          AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${`${todayStr.slice(0, 8)}01`} AND je.entry_date <= ${todayStr}
        GROUP BY ga.account_subtype
      `,
    ]);

    // Revenue is TURNOVER, as the income statement's Revenue line: the other-income
    // band (revenueBand) is left out of it. Profit still counts every revenue-type
    // account, as the statement's net profit does.
    const totalRevenue = turnover(revenueRows as RevenueRow[]);
    const priorRevenue = turnover(priorRevenueRows as RevenueRow[]);
    const allRevenue = sumRevenue(revenueRows as RevenueRow[]);
    const totalExpenses = Number((expenseRows as DbRow[])[0]?.total || 0);
    const priorExpenses = Number((priorExpenseRows as DbRow[])[0]?.total || 0);
    const cashTotal = Number((cashRows as DbRow[])[0]?.total || 0);
    const priorCash = Number((priorCashRows as DbRow[])[0]?.total || 0);
    const netProfit = allRevenue - totalExpenses;
    // Null unless turnover is positive. Zero turnover is no margin (the statement prints a dash
    // too); negative turnover differs from the statement on purpose: its allowNegativeRevenue
    // would print +150% beside a loss.
    const netMargin = marginPct(netProfit, totalRevenue);
    const revenueChange = priorRevenue > 0
      ? ((totalRevenue - priorRevenue) / priorRevenue) * 100
      : totalRevenue > 0 ? 100 : 0;

    return {
      revenue: { total: totalRevenue, priorTotal: priorRevenue, changePercent: revenueChange },
      revenueMtd: turnover(mtdRevenueRows as RevenueRow[]),
      expenses: { total: totalExpenses, priorTotal: priorExpenses },
      netProfit: { amount: netProfit, margin: netMargin },
      cash: { total: cashTotal, priorTotal: priorCash, change: cashTotal - priorCash },
      receivables: {
        total: arBook.total,
        overdue: arBook.overdue,
        overdueDisputed: arBook.overdueDisputed,
        avgDebtorDays: Math.round(Number((arDebtorDaysRows as DbRow[])[0]?.avg_days || 0)),
      },
      payables: {
        total: apBook.total,
        overdue: apBook.overdue,
        avgCreditorDays: Math.round(Number((apCreditorDaysRows as DbRow[])[0]?.avg_days || 0)),
      },
      activity: {
        invoicesIssued: Number((invoicesIssuedRows as DbRow[])[0]?.count || 0),
        paymentsReceived: Number((paymentsReceivedRows as DbRow[])[0]?.count || 0),
        journalsPosted: Number((journalsPostedRows as DbRow[])[0]?.count || 0),
      },
    };
  } catch (err) {
    log.error('Failed to get dashboard KPIs', { error: err }, 'kpi-service');
    throw err;
  }
}
