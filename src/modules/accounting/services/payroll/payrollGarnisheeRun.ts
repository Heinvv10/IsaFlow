/**
 * Garnishee orders in a pay run (wave 6 GA): read at calculate, recorded per run, applied to the balances at approval
 * and restored at reopen.
 *
 *  - calculate (payrollRunService): loadRunGarnisheeOrders gives each employee's orders in force for the run's period
 *    (active, or ended on or after the period's start: an end date is the last day the order runs, so ending an order
 *    with a future date, or reopening its last month, keeps that month's instalment; started on or before the period's
 *    end; balance not nil; satisfied orders never) to the calculator,
 *    and replaceRunGarnisheeDeductions records what each line took. The balance is NEVER moved here.
 *  - approve (payrollApprovalService): judgeGarnisheeBalances runs with the reads, before the first write, and refuses a
 *    run whose deduction is more than an order still owes (another approval moved the balance since this run was
 *    costed), or whose orders changed since it was costed (an order entered after calculation that is in force for the
 *    period, or one ended after calculation with an end date before the period): recalculate. A run that is already
 *    'approved' (re-approved to post its journal: a legacy row approved with no journal linked; a reversal of an approved
 *    run's journal is refused, payrollJournalReversalGuard) is not judged on its orders again:
 *    its deductions were paid, and an order captured since belongs to a later run. applyRunGarnishees, after the header is approved, marks the run's deductions applied and
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
import { judgeConfirmedCreditorPayments } from './payrollBankFileReapproval';
import type { GarnisheeDeduction, GarnisheeKind, GarnisheeOrderInput } from './payrollGarnishee';
import type { ValidationResult } from './payrollTypes';

const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Each employee's orders in force for the period [periodStart, periodEnd], keyed by employee id. GC2 (1057): the
 * balance this run may take adds back what a confirmed salary bank file of THIS run already paid the creditor (the
 * order's balance keeps that payment through a reopen), so recalculating a reopened run whose file the bank paid
 * deducts it again, and its re-approval counts it once (payroll_garnishee_order_counted), even on a last instalment
 * or on an order ended since (breaker N1): such an order is loaded for exactly the paid amount, never apportioned.
 */
export async function loadRunGarnisheeOrders(
  companyId: string, employeeIds: readonly string[], periodStart: unknown, periodEnd: unknown, runId?: string,
): Promise<Map<string, GarnisheeOrderInput[]>> {
  const byEmployee = new Map<string, GarnisheeOrderInput[]>();
  if (employeeIds.length === 0) return byEmployee;
  const rows = (await sql`
    SELECT o.id::text AS id, o.employee_id::text AS employee_id, o.kind, o.reference, o.creditor_name,
           CASE WHEN p.paid > 0 THEN p.paid ELSE o.instalment END AS instalment,
           CASE WHEN p.paid > 0 THEN p.paid ELSE o.balance END AS balance, o.priority, o.created_at,
           (p.paid = 0 AND (o.start_date > ${day(periodStart)}::date OR o.end_date < ${day(periodEnd)}::date)) AS part_month
      FROM payroll_garnishee_orders o
      CROSS JOIN LATERAL (${runCreditorPaidSql(runId ?? null)}) p
     WHERE o.company_id = ${companyId}::uuid AND o.employee_id::text = ANY(${[...employeeIds]}::text[])
       AND (
         -- GC2 (breaker N1): an order THIS run's confirmed bank file paid is taken again for exactly that amount, whatever
         -- has happened to the order since (ended, even backdated before the period; satisfied): the bank paid it, and
         -- the re-approval guard accepts only that amount. A part-month apportioning would make it differ.
         p.paid > 0
         OR (o.status IN ('active', 'ended') AND o.start_date <= ${day(periodEnd)}::date
             AND (o.end_date IS NULL OR o.end_date >= ${day(periodStart)}::date)
             AND (o.balance IS NULL OR o.balance > 0)))
  `) as DbRow[];
  for (const r of rows) {
    const list = byEmployee.get(String(r.employee_id)) ?? [];
    list.push({
      id: String(r.id), kind: r.kind as GarnisheeKind, reference: String(r.reference), creditorName: String(r.creditor_name),
      instalment: Number(r.instalment), balance: r.balance == null ? null : Number(r.balance), priority: Number(r.priority),
      partMonth: r.part_month === true,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    });
    byEmployee.set(String(r.employee_id), list);
  }
  return byEmployee;
}

/**
 * GC2: what confirmed salary bank files of `runId` paid the creditor of order `o` (alias o), in rands; 0 with no run.
 * Read only where the run's own deductions are NOT applied (calculation, or the approval of a run not yet approved).
 */
function runCreditorPaidSql(runId: string | null) {
  return sql`
    SELECT COALESCE(sum(i.amount_cents), 0)::numeric / 100 AS paid
      FROM payroll_bank_file_items i
      JOIN payroll_bank_files f ON f.id = i.file_id AND f.company_id = i.company_id
     WHERE i.garnishee_order_id = o.id AND i.company_id = o.company_id AND f.status = 'confirmed'
       AND f.run_id = ${runId}::uuid`;
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
 * Before approval's first write: every unapplied deduction of the run fits what its order still owes, and (unless the
 * run is already approved) no order was entered or ended since the run was costed.
 * Refused as PayrollApprovalRefusedError (a 4xx with nothing written). Locks the orders (FOR UPDATE) for the approval.
 */
export async function judgeGarnisheeBalances(companyId: string, runId: string, alreadyApproved = false): Promise<void> {
  await judgeConfirmedCreditorPayments(companyId, runId); // GC2: a creditor a confirmed file paid is never re-deducted differently
  const rows = (await sql`
    SELECT o.creditor_name, o.instalment, o.balance + p.paid AS balance, o.status, d.amount
      FROM payroll_garnishee_deductions d
      JOIN payroll_garnishee_orders o ON o.id = d.order_id AND o.company_id = d.company_id
      CROSS JOIN LATERAL (${runCreditorPaidSql(runId)}) p -- GC2: this run's own confirmed payment is already counted
     WHERE d.run_id = ${runId}::uuid AND d.company_id = ${companyId}::uuid AND NOT d.balance_applied
     ORDER BY o.id
       FOR UPDATE OF o
  `) as DbRow[];
  const over = rows.filter((r) => r.balance != null && Number(r.amount) > Number(r.balance));
  if (over.length > 0) {
    throw new PayrollApprovalRefusedError(`${over.map((r) => `The garnishee order to ${orderName(r)} now owes ${formatMoney(Number(r.balance))} `
      + `but this run deducts ${formatMoney(Number(r.amount))}`).join('; ')}. Another approval changed the balance: recalculate the run.`);
  }
  // A run already approved has paid its deductions: an order captured or ended since (court orders are usually
  // backdated) must not stop its journal posting, and recalculating would deduct from a month already paid.
  if (alreadyApproved) return;
  // Orders entered or ended since the run was costed, that change which orders the run's period takes (the loader's
  // own rule): the run still holds the old deductions. Employees on the run's lines; the run's calculation stamp.
  const stale = (await sql`
    SELECT o.creditor_name, o.instalment, (o.created_at > h.calculated_at) AS entered
      FROM payroll_run_headers h
      JOIN payroll_garnishee_orders o ON o.company_id = h.company_id
       AND o.employee_id IN (SELECT l.employee_id FROM payroll_run_lines l WHERE l.run_id = h.id)
     WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid AND h.calculated_at IS NOT NULL
       AND ((o.created_at > h.calculated_at AND o.status <> 'satisfied' AND o.start_date <= h.period_end
             AND (o.end_date IS NULL OR o.end_date >= h.period_start))
         OR (o.ended_at > h.calculated_at AND o.end_date < h.period_start))
     ORDER BY o.created_at, o.id
  `) as DbRow[];
  if (stale.length > 0) {
    throw new PayrollApprovalRefusedError(`${stale.map((r) => `The garnishee order to ${orderName(r)} was ${r.entered ? 'entered' : 'ended'}`)
      .join('; ')} after this run was calculated, so the run still holds the old garnishee deductions: recalculate the run, then approve it.`);
  }
}

/** An order as the refusals name it: its creditor and instalment, never the court reference (rev #1574 L4). */
const orderName = (r: DbRow): string => `${String(r.creditor_name)} (${formatMoney(Number(r.instalment))} a month)`;

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

/** balance = total_debt - per run max(applied deduction, confirmed file's creditor payment) (1057); nil = satisfied, above nil = active again (an ended order stays ended). */
async function settleBalances(companyId: string, orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0;
  const moved = (await sql`
    UPDATE payroll_garnishee_orders o
       SET balance = o.total_debt - a.applied,
           status = CASE WHEN o.status = 'ended' THEN 'ended'
                         WHEN o.total_debt - a.applied = 0 THEN 'satisfied' ELSE 'active' END
      FROM (SELECT o2.id, public.payroll_garnishee_order_counted(o2.id) AS applied -- GC2 1057: applied, or paid by a confirmed file
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

/**
 * Wave 6 OC (review #1679e): an off-cycle run (bonus or termination) takes no garnishee instalment. The month's
 * instalment is the regular run's, so taking one again on the off-cycle line would deduct it twice in the month. A line
 * with an order in force says so (info). Attaching a termination lump sum is logged for wave 7.
 */
export function offCycleGarnisheeNotice(orders: readonly GarnisheeOrderInput[] | undefined): ValidationResult[] {
  if (!orders || orders.length === 0) return [];
  const named = orders.map((o) => `${o.creditorName} (${o.reference})`).join(', ');
  return [{
    code: 'GARNISHEE_TAKEN_BY_REGULAR_RUN', severity: 'info',
    message: `Garnishee order in force: ${named}. Garnishee instalments are taken by the regular run, not by this off-cycle run.`,
  }];
}
