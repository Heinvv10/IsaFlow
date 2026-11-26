/**
 * Wave 7 GC2 (breaker HIGH on #1929; coordinator ruling): a run whose salary bank file was CONFIRMED with garnishee
 * creditor lines has paid those creditors. If the run is then reopened, recalculated and approved again with another
 * deduction for one of those orders, the order's balance (total_debt less APPLIED deductions) would no longer count what
 * the creditor was actually paid, and later months would garnish (and pay) past the debt: R40 000 collected and paid on
 * a R30 000 order in the breaker's repro.
 *
 * So approval (and re-approval; the MCP approve tool runs the same service) is refused, before any write, when any
 * order on a confirmed file's creditor lines of this run would now be deducted a different amount (nil included) than
 * the confirmed line paid. Raised from judgeGarnisheeBalances (payrollGarnisheeRun), under the approval lock and the
 * run's header lock, as a PayrollApprovalConflictError (409 on the route, a tool error in MCP), naming each order, the
 * confirmed amount and the new amount. The remedy is to recalculate until the deduction matches what was paid (an
 * order ended or a cap since then is corrected through the order, not by re-deducting a payment already made).
 * Read-only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatCents } from '@/lib/money/formatMoney';
import { PayrollApprovalConflictError } from './payrollApprovalRefusal';

export async function judgeConfirmedCreditorPayments(companyId: string, runId: string): Promise<void> {
  const rows = (await sql`
    WITH paid AS (
      SELECT i.garnishee_order_id AS order_id, sum(i.amount_cents) AS cents
        FROM payroll_bank_file_items i
        JOIN payroll_bank_files f ON f.id = i.file_id AND f.company_id = i.company_id
       WHERE f.company_id = ${companyId}::uuid AND f.run_id = ${runId}::uuid AND f.status = 'confirmed'
         AND i.garnishee_order_id IS NOT NULL
       GROUP BY i.garnishee_order_id
    )
    SELECT o.creditor_name, e.employee_number, paid.cents::text AS paid_cents,
           COALESCE((SELECT round(d.amount * 100)::bigint FROM payroll_garnishee_deductions d
                      WHERE d.run_id = ${runId}::uuid AND d.order_id = paid.order_id AND d.company_id = ${companyId}::uuid), 0)::text AS new_cents
      FROM paid
      JOIN payroll_garnishee_orders o ON o.id = paid.order_id AND o.company_id = ${companyId}::uuid
      JOIN payroll_employees e ON e.id = o.employee_id AND e.company_id = o.company_id
     ORDER BY o.kind, o.priority, o.created_at, o.id
  `) as DbRow[];
  const differ = rows.filter((r) => String(r.paid_cents) !== String(r.new_cents));
  if (differ.length === 0) return;
  throw new PayrollApprovalConflictError(`${differ.map((r) => `The garnishee order to ${String(r.creditor_name)} (employee ${String(r.employee_number)}) `
    + `was paid ${formatCents(Number(r.paid_cents))} by this run's confirmed salary bank file, but the run would now deduct `
    + `${formatCents(Number(r.new_cents))}`).join('; ')}. Approving it would leave the order's balance out of step with what the `
    + 'creditor was paid: recalculate the run so each of these deductions equals what the bank paid, then approve it.');
}
