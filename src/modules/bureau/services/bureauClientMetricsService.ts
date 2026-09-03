/**
 * Client-home metric snapshot for the bureau Level 2 home.
 *
 * The query shapes are copied from pages/api/accounting/dashboard-stats.ts so
 * these numbers match the Trial Balance / aging reports. Reads on the
 * RLS-bypassing @/lib/neon pool — the CALLER must have already verified that the
 * companyId belongs to the authenticated user: either via getBureauClientForUser
 * (the firm/bureau path, /api/bureau/client/[companyId]) OR via withAuth's
 * company_users membership check on the active company (the direct-client path,
 * /api/home). Every query is scoped to the single companyId; this function adds
 * no new tenant surface.
 */
import { sql } from '@/lib/neon';
import { AR_OPEN_STATUSES, AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';

type Scalar = number | string | null | undefined;

export interface ClientMetricsRows {
  cash: Scalar;
  ar: Scalar;
  ap: Scalar;
  revenue: Scalar;
  expenses: Scalar;
}

export interface ClientMetrics {
  cash: number;
  ar: number;
  ap: number;
  revenueMtd: number;
  profitMtd: number;
}

/** Driver-safe coercion: aggregates may arrive as numeric strings; null/NaN → 0. */
function num(v: Scalar): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Pure: maps raw aggregate rows to the metric set; profit = revenue − expenses. */
export function shapeClientMetrics(r: ClientMetricsRows): ClientMetrics {
  const revenueMtd = num(r.revenue);
  const expensesMtd = num(r.expenses);
  return {
    cash: num(r.cash),
    ar: num(r.ar),
    ap: num(r.ap),
    revenueMtd,
    profitMtd: revenueMtd - expensesMtd,
  };
}

/** Runs 5 parallel aggregate queries and returns a typed metric set. Caller must pre-verify the companyId belongs to the authenticated user (getBureauClientForUser for the bureau path, or withAuth's company_users membership for the direct /api/home path). */
export async function clientMetricsSnapshot(companyId: string): Promise<ClientMetrics> {
  const now = new Date();
  // NOTE: month boundary uses server local time — matches dashboard-stats.ts
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const [cash, ar, ap, revenue, expenses] = await Promise.all([
    // Cash: GL bank-account balances (matches Trial Balance, not raw bank_transactions).
    // Sums all bank accounts into one total.
    //
    // Shape copied from dashboard-stats.ts, including its two fixes: the posted
    // filter lives inside the subquery (in the old LEFT JOIN ON-clause it
    // restricted nothing and draft lines leaked into cash), and is_active is not
    // a filter (a picker flag cannot decide whether an account holds money).
    sql`
      SELECT COALESCE(SUM(b.balance), 0) AS total
        FROM gl_accounts ga
        LEFT JOIN (
          SELECT jl.gl_account_id, SUM(jl.debit - jl.credit) AS balance
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id = ${companyId}::UUID
            AND je.company_id = ${companyId}::UUID
            AND je.status = 'posted'
          GROUP BY jl.gl_account_id
        ) b ON b.gl_account_id = ga.id
       WHERE ga.account_subtype = 'bank' AND ga.company_id = ${companyId}::UUID
    `,
    // AR open (same allowlist as arAgingService)
    sql`
      SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM customer_invoices
       WHERE company_id = ${companyId}::UUID
         AND status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
    `,
    // AP open (same allowlist as apAgingService)
    sql`
      SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM supplier_invoices
       WHERE company_id = ${companyId}::UUID
         AND status = ANY(${Array.from(AP_OPEN_STATUSES)}::text[])
    `,
    // Revenue MTD — SUM(credit - debit), matches dashboard-stats.ts revenue shape exactly
    sql`
      SELECT COALESCE(SUM(credit - debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE ga.account_type = 'revenue' AND je.status = 'posted'
         AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID AND je.entry_date >= ${monthStart}
    `,
    // Expenses MTD — SUM(debit - credit), matches dashboard-stats.ts expense shape.
    // jl.company_id filter added (dashboard-stats omits it) as defense-in-depth: the
    // multi-tenant rule requires every query scoped by company_id, and it keeps this
    // symmetric with the revenue query. Result-identical on valid data (jl.company_id
    // always equals its entry's company_id via the NOT-NULL journal_entry_id FK).
    sql`
      SELECT COALESCE(SUM(debit - credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE ga.account_type = 'expense' AND je.status = 'posted'
         AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID AND je.entry_date >= ${monthStart}
    `,
  ]);

  return shapeClientMetrics({
    cash: (cash as Array<{ total: Scalar }>)[0]?.total,
    ar: (ar as Array<{ total: Scalar }>)[0]?.total,
    ap: (ap as Array<{ total: Scalar }>)[0]?.total,
    revenue: (revenue as Array<{ total: Scalar }>)[0]?.total,
    expenses: (expenses as Array<{ total: Scalar }>)[0]?.total,
  });
}
