/**
 * Cash Flow Forecast — Data Service
 * DB query helpers: actual weekly cash flow, bank balance, receivables, payables, recurring templates.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

export interface CashFlowPeriod {
  weekStart: string;
  inflows: number;
  outflows: number;
  netFlow: number;
  runningBalance: number;
}

export interface HistoricalCashFlow {
  month: string;
  inflow: number;
  outflow: number;
  net: number;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

export function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

export function toDateStr(val: unknown): string {
  if (val instanceof Date) return fmtDate(val);
  if (typeof val === 'string') return val.slice(0, 10);
  return '';
}

// ── DB helpers (legacy forecast) ──────────────────────────────────────────────

/** Get current total cash balance across all bank accounts */
export async function getCurrentCashBalance(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.account_subtype IN ('bank', 'cash')
        THEN COALESCE(
          (SELECT SUM(jl.debit) - SUM(jl.credit)
           FROM gl_journal_lines jl
           JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
           WHERE jl.gl_account_id = ga.id
             AND jl.company_id = ${companyId}::UUID
             AND je.status = 'posted'
             AND je.company_id = ${companyId}),
          0)
        ELSE 0
      END
    ), 0) AS total_cash
    FROM gl_accounts ga
    WHERE ga.company_id = ${companyId}
      AND ga.account_type = 'asset'
      -- No is_active filter: it is a picker flag, and a deactivated bank or
      -- cash account still holds real money that opening cash must include.
      AND ga.account_subtype IN ('bank', 'cash')
  `) as Record<string, unknown>[];
  return Number(rows[0]?.total_cash ?? 0);
}

/** Get monthly cash inflows and outflows for the last N months */
export async function getHistoricalCashFlows(companyId: string, months: number): Promise<HistoricalCashFlow[]> {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const startStr = startDate.toISOString().split('T')[0]!;

  const rows = (await sql`
    WITH monthly AS (
      SELECT
        date_trunc('month', je.entry_date) AS month,
        COALESCE(SUM(CASE WHEN jl.debit > 0 AND ga.account_subtype IN ('bank', 'cash') THEN jl.debit ELSE 0 END), 0) AS inflow,
        COALESCE(SUM(CASE WHEN jl.credit > 0 AND ga.account_subtype IN ('bank', 'cash') THEN jl.credit ELSE 0 END), 0) AS outflow
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId}
        AND jl.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND ga.account_type = 'asset'
        AND ga.account_subtype IN ('bank', 'cash')
        AND je.entry_date >= ${startStr}::DATE
      GROUP BY date_trunc('month', je.entry_date)
    )
    SELECT
      to_char(month, 'YYYY-MM') AS month,
      inflow,
      outflow,
      (inflow - outflow) AS net
    FROM monthly
    ORDER BY month ASC
  `) as Record<string, unknown>[];

  return rows.map((r: Record<string, unknown>) => ({
    month: String(r.month),
    inflow: Number(r.inflow),
    outflow: Number(r.outflow),
    net: Number(r.net),
  }));
}

/** Get known future receivables (unpaid customer invoices) */
export async function getExpectedReceivables(companyId: string): Promise<Array<{ dueDate: string; amount: number }>> {
  const rows = (await sql`
    SELECT due_date, SUM(total_amount - COALESCE(amount_paid, 0)) AS amount_due
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND ${documentInLedgerAsAtFragment('ci', asAtTodayStr(), companyId)}
      AND ci.status IN ('sent', 'overdue', 'approved')
      AND ci.due_date >= CURRENT_DATE
      AND (total_amount - COALESCE(amount_paid, 0)) > 0
    GROUP BY due_date
    ORDER BY due_date ASC
  `) as Record<string, unknown>[];

  return rows.map((r: Record<string, unknown>) => ({
    dueDate: String(r.due_date),
    amount: Number(r.amount_due),
  }));
}

/** Get known future payables (unpaid supplier invoices) */
export async function getExpectedPayables(companyId: string): Promise<Array<{ dueDate: string; amount: number }>> {
  const rows = (await sql`
    SELECT due_date, SUM(total_amount - COALESCE(amount_paid, 0)) AS amount_due
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}
      AND ${documentInLedgerAsAtFragment('si', asAtTodayStr(), companyId)}
      AND si.status IN ('approved', 'received', 'overdue')
      AND si.due_date >= CURRENT_DATE
      AND (total_amount - COALESCE(amount_paid, 0)) > 0
    GROUP BY due_date
    ORDER BY due_date ASC
  `) as Record<string, unknown>[];

  return rows.map((r: Record<string, unknown>) => ({
    dueDate: String(r.due_date),
    amount: Number(r.amount_due),
  }));
}

/** Get recurring invoice amounts for projection */
export async function getRecurringRevenue(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(total_amount), 0) AS monthly_recurring
    FROM recurring_invoices
    WHERE company_id = ${companyId}
      AND status = 'active'
      AND frequency = 'monthly'
  `) as Record<string, unknown>[];
  return Number(rows[0]?.monthly_recurring ?? 0);
}

// ── AI forecast DB helpers ────────────────────────────────────────────────────

/**
 * Get actual weekly cash flow from bank_transactions for the last N days.
 */
export async function getActualCashFlow(
  companyId: string,
  lookbackDays: number,
): Promise<CashFlowPeriod[]> {
  const rows = (await sql`
    SELECT
      DATE_TRUNC('week', transaction_date)::DATE AS week_start,
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)  AS inflows,
      SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS outflows,
      SUM(amount) AS net_flow
    FROM bank_transactions
    WHERE
      company_id = ${companyId}
      AND transaction_date >= CURRENT_DATE - ${lookbackDays}::INT
      AND status NOT IN ('excluded')
    GROUP BY week_start
    ORDER BY week_start ASC
  `) as DbRow[];

  let running = 0;
  return rows.map((row) => {
    const net = toNum(row['net_flow']);
    running += net;
    return {
      weekStart: toDateStr(row['week_start']),
      inflows: toNum(row['inflows']),
      outflows: toNum(row['outflows']),
      netFlow: net,
      runningBalance: running,
    };
  });
}

export async function getBankBalance(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(amount), 0) AS balance
    FROM bank_transactions
    WHERE company_id = ${companyId}
      AND status NOT IN ('excluded')
  `) as DbRow[];
  return toNum(rows[0]?.['balance']);
}

export type UpcomingItem = { type: 'receivable' | 'payable'; dueDate: string; amount: number; status: string };

export async function getUpcomingReceivablesAndPayables(
  companyId: string,
  horizonDays: number,
): Promise<UpcomingItem[]> {
  const receivables = (await sql`
    SELECT due_date,
           (total_amount - COALESCE(amount_paid, 0)) AS outstanding,
           status
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND ${documentInLedgerAsAtFragment('ci', asAtTodayStr(), companyId)}
      AND ci.status IN ('sent', 'overdue', 'partially_paid')
      AND ci.due_date <= CURRENT_DATE + ${horizonDays}::INT
      AND due_date IS NOT NULL
      AND (total_amount - COALESCE(amount_paid, 0)) > 0
    ORDER BY due_date ASC
  `) as DbRow[];

  const payables = (await sql`
    SELECT due_date,
           (total_amount - COALESCE(amount_paid, 0)) AS outstanding,
           status
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}
      AND ${documentInLedgerAsAtFragment('si', asAtTodayStr(), companyId)}
      AND si.status IN ('approved', 'partially_paid')
      AND si.due_date <= CURRENT_DATE + ${horizonDays}::INT
      AND due_date IS NOT NULL
      AND (total_amount - COALESCE(amount_paid, 0)) > 0
    ORDER BY due_date ASC
  `) as DbRow[];

  return [
    ...receivables.map((r) => ({
      type: 'receivable' as const,
      dueDate: toDateStr(r['due_date']),
      amount: toNum(r['outstanding']),
      status: String(r['status'] ?? ''),
    })),
    ...payables.map((r) => ({
      type: 'payable' as const,
      dueDate: toDateStr(r['due_date']),
      amount: toNum(r['outstanding']),
      status: String(r['status'] ?? ''),
    })),
  ];
}

export type RecurringTemplate = { name: string; frequency: string; entityType: string; nextRunDate: string | null };

export async function getRecurringTemplates(companyId: string): Promise<RecurringTemplate[]> {
  try {
    const rows = (await sql`
      SELECT name, frequency, entity_type, next_run_date
      FROM recurring_transaction_templates
      WHERE company_id = ${companyId} AND is_active = true
      ORDER BY next_run_date ASC NULLS LAST
      LIMIT 20
    `) as DbRow[];
    return rows.map((r) => ({
      name: String(r['name'] ?? ''),
      frequency: String(r['frequency'] ?? ''),
      entityType: String(r['entity_type'] ?? ''),
      nextRunDate: r['next_run_date'] ? toDateStr(r['next_run_date']) : null,
    }));
  } catch {
    log.warn('recurring_transaction_templates not available, skipping', {}, 'cashFlowForecast');
    return [];
  }
}
