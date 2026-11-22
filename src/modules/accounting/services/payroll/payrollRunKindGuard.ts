/**
 * The forward-compat guard (wave 6 FQa, grill F3/F4/F8/F28). This release costs, approves, posts, reopens and prints
 * only REGULAR runs (monthly; weekly and fortnightly since FQd) of employees whose tax status and assignments it
 * knows. Later wave-6 releases add off-cycle runs. If production is rolled back to this release (code only, never
 * migrations), this guard is what stops it costing those rows as if they were ordinary: it refuses, naming why, before any write.
 *
 * Called from the SERVICES (calculatePayrollRun, approvePayrollRun and previewPayrollApproval, postPayrollRunJournal,
 * reopenPayrollRun, getPayslips; EF adds emp201Service and irp5DataService, BF its bank-file service), never from a
 * route, so MCP tools and bureau paths are covered too (tests/unit/services/payroll/payrollRunKindGuardCensus.test.ts).
 *
 * Columns and tables that do not exist yet are read without naming them, so this file runs on today's schema and on
 * every later one: a column through `to_jsonb(row) ->> 'name'` (NULL while absent), a table through
 * `to_regclass` with a CASE that never plans the query while the table is absent (query_to_xml runs it only then).
 * Each later PR lifts exactly its own clause, in its own release.
 * Lifted: the rate_multiplier and quantity_unit 'km' clause, by RI (migration 1017; payrollRunInputUnits prices and splits
 * those rows). With DBF's lift it was the last assignment clause, so the `assignment` clause is gone.
 * Lifted: the db_member_category_factor clause, by DBF (migration 1014; definedBenefitFund.ts values those rows).
 * Lifted: the garnishee clauses (an active order refused costing; a deduction on the run refused every action), by GA
 * (migration 999z), which costs, approves, posts and reopens garnishee orders. A rollback past GA reaches a release that
 * still has them.
 * Added by GA (review of #1574): `garnishee_frequency`. A garnishee instalment is monthly and is taken once per run, so
 * a weekly or fortnightly run would take it four or two times a month. Such a run is refused costing while an employee
 * on it has an order in force, until pro-rating is built. The `frequency` clause is still in force on master (FQc built the
 * weekly engine but did not lift it); FQd lifts it when weekly and fortnightly runs reach the product. That lift removes
 * `frequency` only, never this clause.
 * Lifted: the `frequency` clause for weekly and fortnightly regular runs, by FQd (SUPPORTED_FREQUENCIES). `garnishee_frequency`
 * stays: a weekly or fortnightly run with an employee whose garnishee order is in force is still refused costing.
 *
 * KNOWN LIMIT (wave 6 EF review): `tax_status` is judged on the employee's CURRENT row, not as at the run. The
 * employee-frequency clause is judged as at the run since FQd: on a FINAL run only by approve and post (approval
 * proved every line's employee was paid at the run's frequency), on any other run against the current row.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';

export type RunKindAction = 'calculate' | 'approve' | 'post' | 'reopen' | 'payslip' | 'emp201' | 'irp5' | 'bank_file';

/** The pay frequencies this release costs (wave 6 FQd added weekly and fortnightly). */
export const SUPPORTED_FREQUENCIES = ['monthly', 'weekly', 'fortnightly'] as const;

/**
 * The tax statuses this release costs (migration 967; wave 6 PSP added personal_service_provider, migration 1013). A PSP's
 * months are decided per line on the filings (pspLineFlag, pspFiling), so no action refuses one.
 */
export const KNOWN_TAX_STATUSES = ['employee', 'director', 'independent_contractor', 'personal_service_provider'] as const;

export type RunKindClause =
  | 'frequency' | 'run_kind' | 'tax_status' | 'employee_frequency' | 'garnishee_frequency'
  // Wave 6 FQc (payrollFrequencyGuard): terms a weekly or fortnightly run cannot cost, the EMP201 month, a mid-year change.
  | 'frequency_terms' | 'emp201_month' | 'frequency_change' | 'pay_period_overlap'
  // Wave 6 FQd (payrollFrequencyStraddle): a frequency change that pays days twice or leaves days unpaid.
  | 'frequency_straddle';

export interface RunKindReason {
  clause: RunKindClause;
  detail: string;
}

const ACTION_WORDS: Record<RunKindAction, string> = {
  calculate: 'calculated', approve: 'approved', post: 'posted', reopen: 'reopened', payslip: 'given payslips',
  emp201: 'declared on the EMP201', irp5: 'certified on IRP5s', bank_file: 'paid by bank file',
};

/** Refused before any write: 409 (apiRunKindUnsupported), and an MCP agent sees the message (RUN_KIND_UNSUPPORTED). */
export class RunKindUnsupportedError extends Error {
  readonly code = 'RUN_KIND_UNSUPPORTED';
  constructor(readonly action: RunKindAction, readonly reasons: RunKindReason[]) {
    super(`This pay run cannot be ${ACTION_WORDS[action]} by this version of IsaFlow: ${reasons.map((r) => r.detail).join('; ')}.`);
    this.name = 'RunKindUnsupportedError';
  }
}

export function isRunKindUnsupported(err: unknown): err is RunKindUnsupportedError {
  return err instanceof RunKindUnsupportedError;
}

/** Which clauses each action judges. Costing reads assignments; every action meets the run's shape. */
const COSTING: ReadonlySet<RunKindAction> = new Set(['calculate', 'approve', 'post']);

const names = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(', ') : '');

/**
 * Throw RunKindUnsupportedError when the run (this company's; none found = no refusal, the caller answers its own
 * not-found) is one this release cannot handle for `action`. Read-only.
 * `employeeIds` (calculate): the employees about to be costed, beside the run's stored lines; calculate also counts
 * the company's leavers with an approved severance directive (the severance-only lines it may add).
 */
export async function assertRunKindSupported(
  companyId: string, runId: string, action: RunKindAction,
  opts: { employeeIds?: string[] } = {}, db: TxSql = sql,
): Promise<void> {
  const leavers = action === 'calculate';
  const rows = (await db`
    WITH run AS (
      SELECT h.id, h.company_id, h.pay_frequency, h.run_kind, h.period_start, h.period_end, ${sql.unsafe(payRunFinalSql('h'))} AS final
        FROM payroll_run_headers h
       WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
    ), line_people AS (
      SELECT DISTINCT l.employee_id AS id FROM payroll_run_lines l JOIN run r ON l.run_id = r.id
    ), people AS (
      SELECT e.id, e.employee_number, e.tax_status, e.pay_frequency, (e.id IN (SELECT id FROM line_people)) AS on_line
        FROM payroll_employees e JOIN run r ON e.company_id = r.company_id
       WHERE e.id IN (SELECT id FROM line_people)
          OR e.id::text = ANY(${opts.employeeIds ?? []}::text[])
          OR (${leavers}::boolean AND e.end_date < r.period_start AND EXISTS (
                SELECT 1 FROM tax_directives d
                 WHERE d.company_id = e.company_id AND d.employee_id = e.id
                   AND d.directive_type = 'severance' AND d.status = 'approved'))
    )
    SELECT r.pay_frequency, r.run_kind, r.final,
      (SELECT array_agg(p.employee_number ORDER BY p.employee_number) FROM people p
        WHERE p.tax_status IS NULL OR p.tax_status <> ALL(${[...KNOWN_TAX_STATUSES]}::text[])) AS unknown_status,
      (SELECT array_agg(p.employee_number ORDER BY p.employee_number) FROM people p
        WHERE p.on_line AND p.pay_frequency IS DISTINCT FROM r.pay_frequency) AS other_frequency,
      (SELECT array_agg(DISTINCT p.employee_number) FROM people p
         JOIN payroll_garnishee_orders g ON g.employee_id = p.id AND g.company_id = r.company_id
        WHERE r.pay_frequency IS DISTINCT FROM 'monthly'
          AND g.status IN ('active', 'ended') AND g.start_date <= r.period_end
          AND (g.end_date IS NULL OR g.end_date >= r.period_start)
          AND (g.balance IS NULL OR g.balance > 0)) AS garnishee_off_month
      FROM run r
  `) as DbRow[];
  const row = rows[0];
  if (!row) return;
  const reasons = judgeRunKind(row, action);
  if (reasons.length > 0) throw new RunKindUnsupportedError(action, reasons);
}

/** The reasons, from the guard's one row. Exported for the unit tests of each clause's wording and action set. */
export function judgeRunKind(row: DbRow, action: RunKindAction): RunKindReason[] {
  const reasons: RunKindReason[] = [];
  // Wave 6 FQd lifts the clause for weekly and fortnightly regular runs; any other frequency still fails closed.
  if (!(SUPPORTED_FREQUENCIES as readonly unknown[]).includes(row.pay_frequency)) {
    reasons.push({ clause: 'frequency', detail: `it is a ${String(row.pay_frequency)} run, and only monthly, weekly and fortnightly runs are supported` });
  }
  // IRP5 and EMP501 certificates stay monthly-only this wave (coordinator, #1622 x EFb #1568): a weekly or fortnightly
  // run's figures are not certified until wave 7 proves them on the certificate.
  else if (action === 'irp5' && row.pay_frequency !== 'monthly') {
    reasons.push({ clause: 'frequency', detail: `it is a ${String(row.pay_frequency)} run, and IRP5 certificates cover monthly runs only in this release` });
  }
  // Wave 6 OC lifts the off-cycle clause: a monthly off-cycle (bonus or termination) run is costed, approved, posted,
  // reopened and printed by this release (payrollOffCycle*.ts). Any other kind is still refused.
  if (row.run_kind !== 'regular' && row.run_kind !== 'off_cycle') {
    reasons.push({ clause: 'run_kind', detail: `it is a '${String(row.run_kind)}' run, and only regular and off-cycle runs are supported` });
  } else if (row.run_kind === 'off_cycle' && row.pay_frequency !== 'monthly') {
    // FQd costs weekly and fortnightly REGULAR runs; an off-cycle run is monthly only (OC creates no other).
    reasons.push({ clause: 'run_kind', detail: `it is a ${String(row.pay_frequency)} off-cycle run, and off-cycle runs are monthly only` });
  }
  if (action !== 'reopen' && names(row.unknown_status)) {
    reasons.push({ clause: 'tax_status', detail: `employees ${names(row.unknown_status)} have a tax status this version does not know` });
  }
  // As at the run (wave 6 FQd): approving judged each line's employee against the run's frequency, so a FINAL run's
  // lines were paid at it; a later change of the employee (allowed only at a tax-year start) does not refuse its payslip,
  // EMP201 or IRP5. Approve and post judge the current employees, as does every action on a run not yet final.
  const judgesFrequency = action === 'approve' || action === 'post' || row.final !== true;
  if (action !== 'reopen' && action !== 'calculate' && judgesFrequency && names(row.other_frequency)) {
    reasons.push({ clause: 'employee_frequency', detail: `employees ${names(row.other_frequency)} are not paid at the run's frequency` });
  }
  if (COSTING.has(action) && names(row.garnishee_off_month)) {
    reasons.push({ clause: 'garnishee_frequency', detail: `employees ${names(row.garnishee_off_month)} have garnishee orders, whose monthly instalments are not yet pro-rated for a ${String(row.pay_frequency)} run` });
  }
  return reasons;
}
