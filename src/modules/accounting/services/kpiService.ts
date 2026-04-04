/**
 * KPI Dashboard Service
 * Real-time financial KPIs from the general ledger, invoices, and bank accounts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Types ───────────────────────────────────────────────────────────────────

export interface DashboardKPIs {
  revenue: { total: number; priorTotal: number; changePercent: number };
  expenses: { total: number; priorTotal: number };
  grossProfit: { amount: number; margin: number };
  netProfit: { amount: number; margin: number };
  cash: { total: number; priorTotal: number; change: number };
  receivables: { total: number; overdue: number; avgDebtorDays: number };
  payables: { total: number; overdue: number; avgCreditorDays: number };
  activity: { invoicesIssued: number; paymentsReceived: number; journalsPosted: number };
}

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

// ── Dashboard KPIs ──────────────────────────────────────────────────────────

export async function getDashboardKPIs(companyId: string,
  fromDate: string,
  toDate: string
): Promise<DashboardKPIs> {
  try {
    // Calculate prior period (same duration before fromDate)
    const from = new Date(fromDate);
    const to = new Date(toDate);
    const durationMs = to.getTime() - from.getTime();
    const priorFrom = new Date(from.getTime() - durationMs);
    const priorFromStr = priorFrom.toISOString().slice(0, 10);
    const priorToStr = new Date(from.getTime() - 86400000).toISOString().slice(0, 10);

    const [
      revenueRows,
      priorRevenueRows,
      expenseRows,
      priorExpenseRows,
      cashRows,
      priorCashRows,
      arRows,
      arOverdueRows,
      arDebtorDaysRows,
      apRows,
      apOverdueRows,
      apCreditorDaysRows,
      invoicesIssuedRows,
      paymentsReceivedRows,
      journalsPostedRows,
    ] = await Promise.all([
      // Current period revenue
      sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${fromDate} AND je.entry_date <= ${toDate}
      `,
      // Prior period revenue
      sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${priorFromStr} AND je.entry_date <= ${priorToStr}
      `,
      // Current period expenses
      sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'expense' AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${fromDate} AND je.entry_date <= ${toDate}
      `,
      // Prior period expenses
      sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'expense' AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${priorFromStr} AND je.entry_date <= ${priorToStr}
      `,
      // Current cash position (sum of all bank account balances from transactions)
      sql`
        SELECT COALESCE(SUM(bt.amount), 0) AS total
        FROM bank_transactions bt
        JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        WHERE ga.account_subtype = 'bank' AND ga.is_active = true
          AND bt.company_id = ${companyId}::UUID
      `,
      // Prior period cash (transactions up to prior period end)
      sql`
        SELECT COALESCE(SUM(bt.amount), 0) AS total
        FROM bank_transactions bt
        JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        WHERE ga.account_subtype = 'bank' AND ga.is_active = true
          AND bt.company_id = ${companyId}::UUID
          AND bt.transaction_date <= ${priorToStr}
      `,
      // AR total outstanding
      sql`
        SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM customer_invoices
        WHERE status IN ('approved', 'sent', 'partially_paid', 'overdue')
          AND company_id = ${companyId}::UUID
          AND (total_amount - COALESCE(amount_paid, 0)) > 0
      `,
      // AR overdue
      sql`
        SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM customer_invoices
        WHERE status IN ('approved', 'sent', 'partially_paid', 'overdue')
          AND company_id = ${companyId}::UUID
          AND (total_amount - COALESCE(amount_paid, 0)) > 0
          AND due_date < CURRENT_DATE
      `,
      // Average debtor days
      sql`
        SELECT COALESCE(AVG(
          EXTRACT(EPOCH FROM (COALESCE(paid_at, CURRENT_DATE) - invoice_date)) / 86400
        ), 0) AS avg_days
        FROM customer_invoices
        WHERE status NOT IN ('cancelled', 'draft')
          AND company_id = ${companyId}::UUID
          AND invoice_date >= ${fromDate}
      `,
      // AP total outstanding
      sql`
        SELECT COALESCE(SUM(balance), 0) AS total
        FROM supplier_invoices
        WHERE status IN ('approved', 'partially_paid')
          AND company_id = ${companyId}::UUID
          AND balance > 0
      `,
      // AP overdue
      sql`
        SELECT COALESCE(SUM(balance), 0) AS total
        FROM supplier_invoices
        WHERE status IN ('approved', 'partially_paid')
          AND company_id = ${companyId}::UUID
          AND balance > 0
          AND due_date < CURRENT_DATE
      `,
      // Average creditor days
      sql`
        SELECT COALESCE(AVG(
          EXTRACT(EPOCH FROM (COALESCE(paid_at, CURRENT_DATE) - invoice_date)) / 86400
        ), 0) AS avg_days
        FROM supplier_invoices
        WHERE status NOT IN ('cancelled', 'draft')
          AND company_id = ${companyId}::UUID
          AND invoice_date >= ${fromDate}
      `,
      // Invoices issued this period
      sql`
        SELECT COUNT(*) AS count
        FROM customer_invoices
        WHERE company_id = ${companyId}::UUID
          AND invoice_date >= ${fromDate} AND invoice_date <= ${toDate}
          AND status NOT IN ('cancelled', 'draft')
      `,
      // Payments received this period
      sql`
        SELECT COUNT(*) AS count
        FROM customer_invoices
        WHERE company_id = ${companyId}::UUID
          AND paid_at >= ${fromDate} AND paid_at <= ${toDate}
      `,
      // Journal entries posted this period
      sql`
        SELECT COUNT(*) AS count
        FROM gl_journal_entries
        WHERE company_id = ${companyId}::UUID
          AND status = 'posted'
          AND entry_date >= ${fromDate} AND entry_date <= ${toDate}
      `,
    ]);

    const totalRevenue = Number((revenueRows as Row[])[0]?.total || 0);
    const priorRevenue = Number((priorRevenueRows as Row[])[0]?.total || 0);
    const totalExpenses = Number((expenseRows as Row[])[0]?.total || 0);
    const priorExpenses = Number((priorExpenseRows as Row[])[0]?.total || 0);
    const cashTotal = Number((cashRows as Row[])[0]?.total || 0);
    const priorCash = Number((priorCashRows as Row[])[0]?.total || 0);

    const grossProfit = totalRevenue - totalExpenses;
    const grossMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const revenueChange = priorRevenue > 0
      ? ((totalRevenue - priorRevenue) / priorRevenue) * 100
      : totalRevenue > 0 ? 100 : 0;

    return {
      revenue: { total: totalRevenue, priorTotal: priorRevenue, changePercent: revenueChange },
      expenses: { total: totalExpenses, priorTotal: priorExpenses },
      grossProfit: { amount: grossProfit, margin: grossMargin },
      netProfit: { amount: grossProfit, margin: grossMargin },
      cash: { total: cashTotal, priorTotal: priorCash, change: cashTotal - priorCash },
      receivables: {
        total: Number((arRows as Row[])[0]?.total || 0),
        overdue: Number((arOverdueRows as Row[])[0]?.total || 0),
        avgDebtorDays: Math.round(Number((arDebtorDaysRows as Row[])[0]?.avg_days || 0)),
      },
      payables: {
        total: Number((apRows as Row[])[0]?.total || 0),
        overdue: Number((apOverdueRows as Row[])[0]?.total || 0),
        avgCreditorDays: Math.round(Number((apCreditorDaysRows as Row[])[0]?.avg_days || 0)),
      },
      activity: {
        invoicesIssued: Number((invoicesIssuedRows as Row[])[0]?.count || 0),
        paymentsReceived: Number((paymentsReceivedRows as Row[])[0]?.count || 0),
        journalsPosted: Number((journalsPostedRows as Row[])[0]?.count || 0),
      },
    };
  } catch (err) {
    log.error('Failed to get dashboard KPIs', { error: err }, 'kpi-service');
    throw err;
  }
}

// ── Revenue Chart ───────────────────────────────────────────────────────────

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
      month: new Date(r.month_start).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
      revenue: Math.abs(Number(r.revenue || 0)),
      expenses: Math.abs(Number(r.expenses || 0)),
    }));
  } catch (err) {
    log.error('Failed to get revenue chart', { error: err }, 'kpi-service');
    throw err;
  }
}

// ── Cash Flow Chart ─────────────────────────────────────────────────────────

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
      month: new Date(r.month_start).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
      inflows: Number(r.inflows || 0),
      outflows: Number(r.outflows || 0),
    }));
  } catch (err) {
    log.error('Failed to get cash flow chart', { error: err }, 'kpi-service');
    throw err;
  }
}

// ── Aging Breakdown ─────────────────────────────────────────────────────────

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

    // Ensure all buckets exist in correct order
    const bucketOrder = ['Current', '30 Days', '60 Days', '90+ Days'];
    const bucketMap = new Map<string, number>();
    for (const b of bucketOrder) bucketMap.set(b, 0);
    for (const r of rows) {
      bucketMap.set(String(r.bucket), Number(r.total || 0));
    }

    return bucketOrder.map(name => ({ name, value: bucketMap.get(name) || 0 }));
  } catch (err) {
    log.error('Failed to get aging breakdown', { error: err, type }, 'kpi-service');
    throw err;
  }
}

// ── Top Customers ───────────────────────────────────────────────────────────

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

// ── Top Expense Categories ──────────────────────────────────────────────────

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
