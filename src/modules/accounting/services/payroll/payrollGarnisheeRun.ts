/**
 * Garnishee orders in a pay run (wave 6 GA): read at calculate, recorded per run, applied to the balances at approval
 * and restored at reopen.
 *
 *  - calculate (payrollRunService): loadRunGarnisheeOrders gives each employee's orders in force for the run's period
 *    (active, started on or before the period's end, not ended before its start, balance not nil) to the calculator,
 *    and replaceRunGarnisheeDeductions records what each line took. The balance is NEVER moved here.
 *  - approve (payrollApprovalService): judgeGarnisheeBalances runs with the reads, before the first write, and refuses a
 *    run whose deduction is more than an order still owes (another approval moved the balance since this run was
 *    costed: recalculate). applyRunGarnishees, after the header is approved, marks the run's deductions applied and
 *    sets each order's balance to its total debt less what is applied (an order reaching nil is 'satisfied').
 *  - reopen (payrollRunReopen): restoreRunGarnishees, after the header leaves 'approved', unmarks them and puts the
 *    balance back ('satisfied' returns to 'active').
 * Every step runs under the company's payroll approval lock and the run's header lock, which the three callers take
 * first, so two approvals cannot move one order's balance at once. The 999z triggers hold the balance to
 * total_debt - applied, and refuse an applied flag the run's status does not allow.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { PayrollApprovalRefusedError } from './payrollApprovalRefusal';
import type { GarnisheeDeduction, GarnisheeKind, GarnisheeOrderInput } from './payrollGarnishee';

const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** Each employee's orders in force for the period [periodStart, periodEnd], keyed by employee id. */
export async function loadRunGarnisheeOrders(
  companyId: string, employeeIds: readonly string[], periodStart: unknown, periodEnd: unknown,
): Promise<Map<string, GarnisheeOrderInput[]>> {
  const byEmployee = new Map<string, GarnisheeOrderInput[]>();
  if (employeeIds.length === 0) return byEmployee;
  const rows = (await sql`
    SELECT id::text AS id, employee_id::text AS employee_id, kind, reference, creditor_name, instalment, balance, priority, created_at
      FROM payroll_garnishee_orders
     WHERE company_id = ${companyId}::uuid AND employee_id::text = ANY(${[...employeeIds]}::text[])
       AND status = 'active' AND start_date <= ${day(periodEnd)}::date
       AND (end_date IS NULL OR end_date >= ${day(periodStart)}::date)
       AND (balance IS NULL OR balance > 0)
  `) as DbRow[];
  for (const r of rows) {
    const list = byEmployee.get(String(r.employee_id)) ?? [];
    list.push({
      id: String(r.id), kind: r.kind as GarnisheeKind, reference: String(r.reference), creditorName: String(r.creditor_name),
      instalment: Number(r.instalment), balance: r.balance == null ? null : Number(r.balance), priority: Number(r.priority),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    });
    byEmployee.set(String(r.employee_id), list);
  }
  return byEmployee;
}

/** Replace the run's deductions with what this calculation took (amounts of nil are not recorded). */
export async function replaceRunGarnisheeDeductions(
  companyId: string, runId: string, lines: ReadonlyArray<{ employeeId: string; garnishees: readonly GarnisheeDeduction[] }>,
): Promise<void> {
  await sql`DELETE FROM payroll_garnishee_deductions WHERE run_id = ${runId}::uuid AND company_id = ${companyId}::uuid`;
  const rows = lines.flatMap((l) => l.garnishees.filter((g) => g.amount > 0).map((g) => ({ employeeId: l.employeeId, ...g })));
  if (rows.length === 0) return;
  await sql`
    INSERT INTO payroll_garnishee_deductions (company_id, run_id, order_id, employee_id, requested, amount)
    SELECT ${companyId}::uuid, ${runId}::uuid, x.order_id, x.employee_id, x.requested, x.amount
      FROM unnest(${rows.map((r) => r.orderId)}::uuid[], ${rows.map((r) => r.employeeId)}::uuid[],
                  ${rows.map((r) => r.requested)}::numeric[], ${rows.map((r) => r.amount)}::numeric[])
           AS x(order_id, employee_id, requested, amount)
  `;
}

/**
 * Before approval's first write: every unapplied deduction of the run fits what its order still owes.
 * Refused as PayrollApprovalRefusedError (a 4xx with nothing written). Locks the orders (FOR UPDATE) for the approval.
 */
export async function judgeGarnisheeBalances(companyId: string, runId: string): Promise<void> {
  const rows = (await sql`
    SELECT o.reference, o.balance, o.status, d.amount
      FROM payroll_garnishee_deductions d
      JOIN payroll_garnishee_orders o ON o.id = d.order_id AND o.company_id = d.company_id
     WHERE d.run_id = ${runId}::uuid AND d.company_id = ${companyId}::uuid AND NOT d.balance_applied
     ORDER BY o.id
       FOR UPDATE OF o
  `) as DbRow[];
  const over = rows.filter((r) => r.balance != null && Number(r.amount) > Number(r.balance));
  if (over.length > 0) {
    throw new PayrollApprovalRefusedError(`Garnishee order ${over.map((r) => `${String(r.reference)} now owes ${formatMoney(Number(r.balance))} `
      + `but this run deducts ${formatMoney(Number(r.amount))}`).join('; ')}. Another approval changed the balance: recalculate the run.`);
  }
}

/** After the header is approved: the run's deductions move their orders' balances. Returns the orders moved. */
export async function applyRunGarnishees(companyId: string, runId: string): Promise<number> {
  const applied = (await sql`
    UPDATE payroll_garnishee_deductions SET balance_applied = true
     WHERE run_id = ${runId}::uuid AND company_id = ${companyId}::uuid AND NOT balance_applied
     RETURNING order_id
  `) as DbRow[];
  return settleBalances(companyId, applied.map((r) => String(r.order_id)));
}

/** After the header leaves 'approved' (reopen): the run's deductions no longer count against the balances. */
export async function restoreRunGarnishees(companyId: string, runId: string): Promise<number> {
  const restored = (await sql`
    UPDATE payroll_garnishee_deductions SET balance_applied = false
     WHERE run_id = ${runId}::uuid AND company_id = ${companyId}::uuid AND balance_applied
     RETURNING order_id
  `) as DbRow[];
  return settleBalances(companyId, restored.map((r) => String(r.order_id)));
}

/** balance = total_debt - applied deductions; nil = satisfied, above nil = active again (an ended order stays ended). */
async function settleBalances(companyId: string, orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0;
  const moved = (await sql`
    UPDATE payroll_garnishee_orders o
       SET balance = o.total_debt - a.applied,
           status = CASE WHEN o.status = 'ended' THEN 'ended'
                         WHEN o.total_debt - a.applied = 0 THEN 'satisfied' ELSE 'active' END
      FROM (SELECT o2.id, COALESCE((SELECT sum(d.amount) FROM payroll_garnishee_deductions d
                                     WHERE d.order_id = o2.id AND d.balance_applied), 0) AS applied
              FROM payroll_garnishee_orders o2
             WHERE o2.company_id = ${companyId}::uuid AND o2.id::text = ANY(${[...new Set(orderIds)]}::text[])) a
     WHERE o.id = a.id AND o.company_id = ${companyId}::uuid AND o.total_debt IS NOT NULL
     RETURNING o.id
  `) as DbRow[];
  return moved.length;
}

/** The run's garnishee deductions by payable account, for the journal (a credit per account). */
export async function runGarnisheeCredits(companyId: string, runId: string): Promise<Array<{
  accountId: string; code: string; name: string; isActive: boolean; amount: number;
}>> {
  const rows = (await sql`
    SELECT a.id::text AS id, a.account_code, a.account_name, a.is_active, sum(d.amount) AS amount
      FROM payroll_garnishee_deductions d
      JOIN payroll_garnishee_orders o ON o.id = d.order_id AND o.company_id = d.company_id
      JOIN gl_accounts a ON a.id = o.payable_account_id AND a.company_id = o.company_id
     WHERE d.run_id = ${runId}::uuid AND d.company_id = ${companyId}::uuid
     GROUP BY a.id, a.account_code, a.account_name, a.is_active
     ORDER BY a.account_code, a.id
  `) as DbRow[];
  return rows.map((r) => ({
    accountId: String(r.id), code: String(r.account_code), name: String(r.account_name), isActive: r.is_active === true, amount: Number(r.amount),
  }));
}

/** Each employee's garnishee deductions on the run, as payslip lines ("Garnishee order <ref> (<creditor>)"). */
export async function runGarnisheePayslipItems(companyId: string, runId: string): Promise<Map<string, Array<{ label: string; code: string; amount: number }>>> {
  const rows = (await sql`
    SELECT d.employee_id::text AS employee_id, o.reference, o.creditor_name, d.amount
      FROM payroll_garnishee_deductions d
      JOIN payroll_garnishee_orders o ON o.id = d.order_id AND o.company_id = d.company_id
     WHERE d.run_id = ${runId}::uuid AND d.company_id = ${companyId}::uuid
     ORDER BY o.kind, o.priority, o.created_at, o.id
  `) as DbRow[];
  const byEmployee = new Map<string, Array<{ label: string; code: string; amount: number }>>();
  for (const r of rows) {
    const list = byEmployee.get(String(r.employee_id)) ?? [];
    list.push({ label: `Garnishee order ${String(r.reference)} (${String(r.creditor_name)})`, code: '', amount: Number(r.amount) });
    byEmployee.set(String(r.employee_id), list);
  }
  return byEmployee;
}
