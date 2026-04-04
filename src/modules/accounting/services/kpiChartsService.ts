/**
 * KPI Charts Service
 * Revenue trends, cash flow, aging breakdowns, top customers, and expense categories.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

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

export async function getRevenueChart(companyId: string, months: number): Promise<ChartPoint[]> {
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
        COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expenses
      FROM months m
      LEFT JOIN gl_journal_entries je
        ON je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND je.entry_date >= m.month_start
        AND je.entry_date < m.month_start + '1 month'::INTERVAL
      LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        AND ga.account_type IN ('revenue', 'expense')
      GROUP BY m.month_start
      ORDER BY m.month_start
    `) as Row[];

    return rows.map((r: Row) => ({
      month: new Date(String(r.month_start)).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
      revenue: Math.abs(Number(r.revenue || 0)),
      expenses: Math.abs(Number(r.expenses || 0)),
    }));
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
      LEFT JOIN bank_transactions bt
        ON bt.company_id = ${companyId}::UUID
        AND bt.transaction_date >= m.month_start
        AND bt.transaction_date < m.month_start + '1 month'::INTERVAL
      LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        AND ga.account_subtype = 'bank' AND ga.is_active = true
      GROUP BY m.month_start
      ORDER BY m.month_start
    `) as Row[];

    return rows.map((r: Row) => ({
      month: new Date(String(r.month_start)).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
      inflows: Number(r.inflows || 0),
      outflows: Number(r.outflows || 0),
    }));
  } catch (err) {
    log.error('Failed to get cash flow chart', { error: err }, 'kpi-service');
    throw err;
  }
}

export async function getAgingBreakdown(companyId: string, type: 'ar' | 'ap'): Promise<AgingBreakdownBucket[]> {
  try {
    let rows: Row[];

    if (type === 'ar') {
      rows = (await sql`
        SELECT
          CASE
            WHEN due_date >= CURRENT_DATE THEN 'Current'
            WHEN CURRENT_DATE - due_date <= 30 THEN '30 Days'
            WHEN CURRENT_DATE - due_date <= 60 THEN '60 Days'
            ELSE '90+ Days'
          END AS bucket,
          COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM customer_invoices
        WHERE status IN ('approved', 'sent', 'partially_paid', 'overdue')
          AND company_id = ${companyId}::UUID
          AND (total_amount - COALESCE(amount_paid, 0)) > 0
        GROUP BY bucket
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT
          CASE
            WHEN due_date >= CURRENT_DATE THEN 'Current'
            WHEN CURRENT_DATE - due_date <= 30 THEN '30 Days'
            WHEN CURRENT_DATE - due_date <= 60 THEN '60 Days'
            ELSE '90+ Days'
          END AS bucket,
          COALESCE(SUM(balance), 0) AS total
        FROM supplier_invoices
        WHERE status IN ('approved', 'partially_paid')
          AND company_id = ${companyId}::UUID
          AND balance > 0
        GROUP BY bucket
      `) as Row[];
    }

    const bucketOrder = ['Current', '30 Days', '60 Days', '90+ Days'];
    const bucketMap = new Map<string, number>();
    for (const b of bucketOrder) bucketMap.set(b, 0);
    for (const r of rows) bucketMap.set(String(r.bucket), Number(r.total || 0));

    return bucketOrder.map(name => ({ name, value: bucketMap.get(name) || 0 }));
  } catch (err) {
    log.error('Failed to get aging breakdown', { error: err, type }, 'kpi-service');
    throw err;
  }
}

export async function getTopCustomers(companyId: string, limit: number): Promise<TopCustomer[]> {
  try {
    const rows = (await sql`
      SELECT c.name AS name,
        COALESCE(SUM(ci.total_amount), 0) AS revenue,
        COUNT(ci.id) AS invoice_count
      FROM customer_invoices ci
      JOIN customers c ON c.id = ci.customer_id
      WHERE ci.status NOT IN ('cancelled', 'draft')
        AND ci.company_id = ${companyId}::UUID
      GROUP BY c.id, c.name
      ORDER BY revenue DESC
      LIMIT ${limit}
    `) as Row[];

    return rows.map((r: Row) => ({
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
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE ga.account_type = 'expense' AND je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
      GROUP BY ga.id, ga.account_name
      HAVING SUM(jl.debit - jl.credit) > 0
      ORDER BY total DESC
      LIMIT ${limit}
    `) as Row[];

    const totalExpenses = rows.reduce((s: number, r: Row) => s + Number(r.total || 0), 0);

    return rows.map((r: Row) => {
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
