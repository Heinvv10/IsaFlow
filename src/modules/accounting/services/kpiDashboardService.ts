/**
 * KPI Dashboard Service — Core Financial KPIs
 * Revenue, expenses, cash, receivables, payables, and activity metrics.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

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

export async function getDashboardKPIs(companyId: string,
  fromDate: string,
  toDate: string
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
      arRows, arOverdueRows, arDebtorDaysRows,
      apRows, apOverdueRows, apCreditorDaysRows,
      invoicesIssuedRows, paymentsReceivedRows, journalsPostedRows,
    ] = await Promise.all([
      sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${fromDate} AND je.entry_date <= ${toDate}
      `,
      sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${priorFromStr} AND je.entry_date <= ${priorToStr}
      `,
      sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'expense' AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${fromDate} AND je.entry_date <= ${toDate}
      `,
      sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'expense' AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND je.entry_date >= ${priorFromStr} AND je.entry_date <= ${priorToStr}
      `,
      sql`
        SELECT COALESCE(SUM(bt.amount), 0) AS total
        FROM bank_transactions bt
        JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        WHERE ga.account_subtype = 'bank' AND ga.is_active = true
          AND bt.company_id = ${companyId}::UUID
      `,
      sql`
        SELECT COALESCE(SUM(bt.amount), 0) AS total
        FROM bank_transactions bt
        JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        WHERE ga.account_subtype = 'bank' AND ga.is_active = true
          AND bt.company_id = ${companyId}::UUID
          AND bt.transaction_date <= ${priorToStr}
      `,
      sql`
        SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM customer_invoices
        WHERE status IN ('approved', 'sent', 'partially_paid', 'overdue')
          AND company_id = ${companyId}::UUID
          AND (total_amount - COALESCE(amount_paid, 0)) > 0
      `,
      sql`
        SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM customer_invoices
        WHERE status IN ('approved', 'sent', 'partially_paid', 'overdue')
          AND company_id = ${companyId}::UUID
          AND (total_amount - COALESCE(amount_paid, 0)) > 0
          AND due_date < CURRENT_DATE
      `,
      sql`
        SELECT COALESCE(AVG(
          EXTRACT(EPOCH FROM (COALESCE(paid_at, CURRENT_DATE) - invoice_date)) / 86400
        ), 0) AS avg_days
        FROM customer_invoices
        WHERE status NOT IN ('cancelled', 'draft')
          AND company_id = ${companyId}::UUID
          AND invoice_date >= ${fromDate}
      `,
      sql`
        SELECT COALESCE(SUM(balance), 0) AS total
        FROM supplier_invoices
        WHERE status IN ('approved', 'partially_paid')
          AND company_id = ${companyId}::UUID
          AND balance > 0
      `,
      sql`
        SELECT COALESCE(SUM(balance), 0) AS total
        FROM supplier_invoices
        WHERE status IN ('approved', 'partially_paid')
          AND company_id = ${companyId}::UUID
          AND balance > 0
          AND due_date < CURRENT_DATE
      `,
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
