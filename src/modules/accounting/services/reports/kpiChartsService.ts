/**
 * KPI Charts Service
 * Revenue trends, cash flow, aging breakdowns, top customers, and expense categories.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';
import { AGING_BREAKDOWN_LABELS, getOpenBook, type OpenBook } from './dashboardOpenBook';
import { todayInSast } from '@/lib/saDateParser';
import { UNKNOWN_CUSTOMER } from '@/modules/accounting/services/ar/arAgingInvoices';
import { revenueBand } from '../gl/accountClassification';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';


export interface ChartPoint {
  month: string;
  revenue: number;
  expenses: number;
}

export interface CashFlowPoint {
  month: string;
  inflows: number;
  outflows: number;
}

export interface AgingBreakdownBucket {
  name: string;
  value: number;
}

export interface TopCustomer {
  name: string;
  revenue: number;
  invoiceCount: number;
}

export interface TopExpenseCategory {
  accountName: string;
  total: number;
  percentOfExpenses: number;
}

/**
 * Revenue vs expenses per month, the last `months` months ending with the SAST
 * month of `todayStr` (not the UTC CURRENT_DATE), the current one only up to
 * `todayStr`. Revenue is TURNOVER as the Revenue tile and the income
 * statement's Revenue line: rows come per (type, subtype) and `revenueBand`
 * leaves other income out. Signed, never absolute: a month whose credit notes
 * exceed its sales draws below zero.
 */
export async function getRevenueChart(companyId: string, months: number, todayStr: string = todayInSast()): Promise<ChartPoint[]> {
  try {
    const rows = (await sql`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', ${todayStr}::date) - (${months - 1} || ' months')::INTERVAL,
          date_trunc('month', ${todayStr}::date),
          '1 month'::INTERVAL
        )::DATE AS month_start
      )
      SELECT
        m.month_start::text AS month_start,
        ga.account_type,
        ga.account_subtype,
        COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
                          WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit
                          ELSE 0 END), 0) AS total
      FROM months m
      LEFT JOIN gl_journal_entries je
        ON je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND je.entry_date >= m.month_start
        AND je.entry_date < m.month_start + '1 month'::INTERVAL
        AND je.entry_date <= ${todayStr}::date
      LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
      LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        AND ga.account_type IN ('revenue', 'expense')
      GROUP BY m.month_start, ga.account_type, ga.account_subtype
      ORDER BY m.month_start
    `) as DbRow[];

    const byMonth = new Map<string, ChartPoint>();
    for (const r of rows) {
      const key = String(r.month_start);
      const point = byMonth.get(key) ?? {
        month: new Date(key).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
        revenue: 0,
        expenses: 0,
      };
      const total = Number(r.total || 0);
      if (r.account_type === 'revenue' && revenueBand(r.account_subtype ? String(r.account_subtype) : null) === 'turnover') point.revenue += total;
      else if (r.account_type === 'expense') point.expenses += total;
      byMonth.set(key, point);
    }
    return [...byMonth.values()];
  } catch (err) {
    log.error('Failed to get revenue chart', { error: err }, 'kpi-service');
    throw err;
  }
}

export async function getCashFlowChart(companyId: string, months: number): Promise<CashFlowPoint[]> {
  try {
    const rows = (await sql`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE) - (${months - 1} || ' months')::INTERVAL,
          date_trunc('month', CURRENT_DATE),
          '1 month'::INTERVAL
        )::DATE AS month_start
      )
      SELECT
        m.month_start,
        COALESCE(SUM(CASE WHEN bt.amount > 0 THEN bt.amount ELSE 0 END), 0) AS inflows,
        COALESCE(SUM(CASE WHEN bt.amount < 0 THEN ABS(bt.amount) ELSE 0 END), 0) AS outflows
      FROM months m
      -- The bank-subtype restriction lives in the bank_transactions join, as an
      -- EXISTS. It used to be a LEFT JOIN onto gl_accounts, which restricted
      -- nothing at all: unmatched rows survived with NULL account columns and
      -- were still summed. is_active is deliberately absent -- it is a picker
      -- flag, and deactivating an account must not erase its cash movements.
      -- Latent, not benign: R0 delta today only because no inactive bank
      -- account holds a bank_transactions row yet. Do not reinstate.
      LEFT JOIN bank_transactions bt
        ON bt.company_id = ${companyId}::UUID
        AND bt.transaction_date >= m.month_start
        AND bt.transaction_date < m.month_start + '1 month'::INTERVAL
        AND bt.feed_state = 'posted'
        AND EXISTS (
          SELECT 1 FROM gl_accounts ga
          WHERE ga.id = bt.bank_account_id
            AND ga.company_id = ${companyId}::UUID
            AND ga.account_subtype = ANY(${BANK_SUBTYPES as string[]})
        )
      GROUP BY m.month_start
      ORDER BY m.month_start
    `) as DbRow[];

    return rows.map((r: DbRow) => ({
      month: new Date(String(r.month_start)).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
      inflows: Number(r.inflows || 0),
      outflows: Number(r.outflows || 0),
    }));
  } catch (err) {
    log.error('Failed to get cash flow chart', { error: err }, 'kpi-service');
    throw err;
  }
}

/**
 * The dashboard's AR / AP ageing: the aging report's population and buckets as
 * at the SAST day (reports/dashboardOpenBook), plus a Disputed segment, so the
 * donut sums to the report's total and to the Receivables / Payables tile. It
 * used to re-aggregate with its own status list, no disputes, CURRENT_DATE (the
 * UTC session date) and a "90+" that was really "> 60".
 */
export async function getAgingBreakdown(
  companyId: string,
  type: 'ar' | 'ap',
  todayStr: string = todayInSast(),
  /** The open book when the caller already read it (the tiles use the same one). */
  book?: OpenBook,
): Promise<AgingBreakdownBucket[]> {
  try {
    const { buckets } = book ?? await getOpenBook(companyId, type, todayStr);
    return AGING_BREAKDOWN_LABELS.map((name, i) => ({ name, value: buckets[i]! }));
  } catch (err) {
    log.error('Failed to get aging breakdown', { error: err, type }, 'kpi-service');
    throw err;
  }
}

export async function getTopCustomers(companyId: string, limit: number): Promise<TopCustomer[]> {
  try {
    const rows = (await sql`
      SELECT COALESCE(c.name, ${UNKNOWN_CUSTOMER}) AS name,
        COALESCE(SUM(ci.total_amount), 0) AS revenue,
        COUNT(ci.id) AS invoice_count
      FROM customer_invoices ci
      -- LEFT and per id: an invoice naming another tenant's customer keeps its
      -- revenue on the chart, unnamed, and two such ids stay two rows.
      LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ci.company_id
      WHERE ci.status NOT IN ('cancelled', 'draft')
        AND ci.company_id = ${companyId}::UUID
      GROUP BY ci.customer_id, c.name
      ORDER BY revenue DESC
      LIMIT ${limit}
    `) as DbRow[];

    return rows.map((r: DbRow) => ({
      name: String(r.name),
      revenue: Number(r.revenue || 0),
      invoiceCount: Number(r.invoice_count || 0),
    }));
  } catch (err) {
    log.error('Failed to get top customers', { error: err }, 'kpi-service');
    throw err;
  }
}

export async function getTopExpenseCategories(companyId: string, limit: number): Promise<TopExpenseCategory[]> {
  try {
    const rows = (await sql`
      SELECT ga.account_name,
        COALESCE(SUM(jl.debit - jl.credit), 0) AS total
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      WHERE ga.account_type = 'expense' AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
      GROUP BY ga.id, ga.account_name
      HAVING SUM(jl.debit - jl.credit) > 0
      ORDER BY total DESC
      LIMIT ${limit}
    `) as DbRow[];

    const totalExpenses = rows.reduce((s: number, r: DbRow) => s + Number(r.total || 0), 0);

    return rows.map((r: DbRow) => {
      const total = Number(r.total || 0);
      return {
        accountName: String(r.account_name),
        total,
        percentOfExpenses: totalExpenses > 0 ? (total / totalExpenses) * 100 : 0,
      };
    });
  } catch (err) {
    log.error('Failed to get top expense categories', { error: err }, 'kpi-service');
    throw err;
  }
}
