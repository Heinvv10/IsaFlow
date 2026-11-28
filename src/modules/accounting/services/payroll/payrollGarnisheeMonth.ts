/**
 * A month's garnishee deductions across its runs (wave 7 GT, W11; ruling 15; grill F12), and the SQL fragments
 * payrollGarnisheeRun's loader and approval judge share. runCreditorPaidSql and orderName moved here unchanged from
 * payrollGarnisheeRun (file cap); the rest is GT's.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { PayrollApprovalRefusedError } from './payrollApprovalRefusal';
import { payRunFinalSql } from './payRunFinalSql';
import { GARNISHEE_TAKEN_THIS_MONTH } from './payrollGarnisheeTermination';

/**
 * GC2: what confirmed salary bank files of `runId` paid the creditor of order `o` (alias o), in rands; 0 with no run.
 * Read only where the run's own deductions are NOT applied (calculation, or the approval of a run not yet approved).
 */
export function runCreditorPaidSql(runId: string | null) {
  return sql`
    SELECT COALESCE(sum(i.amount_cents), 0)::numeric / 100 AS paid
      FROM payroll_bank_file_items i
      JOIN payroll_bank_files f ON f.id = i.file_id AND f.company_id = i.company_id
     WHERE i.garnishee_order_id = o.id AND i.company_id = o.company_id AND f.status = 'confirmed'
       AND f.run_id = ${runId}::uuid`;
}

/**
 * Wave 7 GT (ruling 15, grill F12): whether another FINAL monthly run of `runId`'s month (same company, period year and
 * month) deducted order `o` (alias o): the regular run for a termination run, a termination run for the regular run.
 * Ledger breaker #1939 D3: also when another run of the month, final or not (reopened since), has a CONFIRMED salary
 * bank file that paid the order's creditor (GC2, 1057): the bank paid that run's instalment, and a reopen keeps it
 * counted, so this run must not deduct the month's instalment again. The run that holds the payment is exempt by the
 * callers' own p.paid test (it re-deducts exactly what it paid).
 * False with no run. Garnishees are costed on monthly runs only (payrollRunKindGuard `garnishee_frequency`).
 */
export function takenByOtherFinalRunSql(runId: string | null) {
  return sql`
    SELECT EXISTS (
      SELECT 1 FROM payroll_run_headers me
        JOIN payroll_run_headers h2 ON h2.company_id = me.company_id AND h2.id <> me.id
         AND h2.period_year = me.period_year AND h2.period_month = me.period_month AND h2.pay_frequency = 'monthly'
        JOIN payroll_garnishee_deductions d2 ON d2.run_id = h2.id AND d2.company_id = h2.company_id AND d2.order_id = o.id
       WHERE me.id = ${runId}::uuid AND me.company_id = o.company_id AND ${sql.unsafe(payRunFinalSql('h2'))})
    OR EXISTS (
      SELECT 1 FROM payroll_run_headers me
        JOIN payroll_run_headers h2 ON h2.company_id = me.company_id AND h2.id <> me.id
         AND h2.period_year = me.period_year AND h2.period_month = me.period_month AND h2.pay_frequency = 'monthly'
        JOIN payroll_bank_files f ON f.run_id = h2.id AND f.company_id = h2.company_id AND f.status = 'confirmed'
        JOIN payroll_bank_file_items i ON i.file_id = f.id AND i.company_id = f.company_id AND i.garnishee_order_id = o.id
       WHERE me.id = ${runId}::uuid AND me.company_id = o.company_id) AS taken`;
}

/** An order as the refusals name it: its creditor and instalment, never the court reference (rev #1574 L4). */
export const orderName = (r: DbRow): string => `${String(r.creditor_name)} (${formatMoney(Number(r.instalment))} a month)`;

/**
 * Wave 7 GT (grill F12): a month deducts an order once. Refused before any write (recalculate) when the run deducts an
 * order another final run of its month has deducted since this run was costed (the other was approved first), or when
 * the run skipped an order as taken by another final run (GARNISHEE_TAKEN_THIS_MONTH) that no final run of the month
 * holds any more (that run was reopened). A confirmed bank file's payment of this run (GC2) is kept, never refused.
 */
export async function judgeMonthGarnishees(companyId: string, runId: string): Promise<void> {
  const twice = (await sql`
    SELECT o.creditor_name, o.instalment
      FROM payroll_garnishee_deductions d
      JOIN payroll_garnishee_orders o ON o.id = d.order_id AND o.company_id = d.company_id
      CROSS JOIN LATERAL (${runCreditorPaidSql(runId)}) p
      CROSS JOIN LATERAL (${takenByOtherFinalRunSql(runId)}) t
     WHERE d.run_id = ${runId}::uuid AND d.company_id = ${companyId}::uuid AND NOT d.balance_applied AND p.paid = 0 AND t.taken
     ORDER BY o.id
  `) as DbRow[];
  if (twice.length > 0) {
    throw new PayrollApprovalRefusedError(`${twice.map((r) => `The garnishee order to ${orderName(r)}`).join('; ')} was deducted by another `
      + 'approved run of this month since this run was calculated, so this run would deduct it twice: recalculate the run, then approve it.');
  }
  const released = (await sql`
    SELECT o.creditor_name, o.instalment
      FROM payroll_run_lines l
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.validation_results::jsonb) = 'array'
                                                   THEN l.validation_results::jsonb ELSE '[]'::jsonb END) v
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(v->'orders') = 'array' THEN v->'orders' ELSE '[]'::jsonb END) x(order_id)
      JOIN payroll_garnishee_orders o ON o.id::text = x.order_id AND o.company_id = ${companyId}::uuid AND o.employee_id = l.employee_id
      CROSS JOIN LATERAL (${takenByOtherFinalRunSql(runId)}) t
     WHERE l.run_id = ${runId}::uuid AND v->>'code' = ${GARNISHEE_TAKEN_THIS_MONTH} AND NOT t.taken
     ORDER BY o.id
  `) as DbRow[];
  if (released.length > 0) {
    throw new PayrollApprovalRefusedError(`${released.map((r) => `The garnishee order to ${orderName(r)}`).join('; ')} was left to another `
      + 'run of this month that is no longer approved, so no run of the month deducts it: recalculate the run, then approve it.');
  }
}
