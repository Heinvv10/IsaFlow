/**
 * The forward-compat guard (wave 6 FQa, grill F3/F4/F8/F28). This release costs, approves, posts, reopens and prints
 * only MONTHLY REGULAR runs of employees whose tax status and assignments it knows. Later wave-6 releases add weekly
 * and fortnightly runs, off-cycle runs, personal service providers, defined-benefit factors, overtime multipliers,
 * travel km and garnishee orders. If production is rolled back to this release (code only, never migrations), this
 * guard is what stops it costing those rows as if they were ordinary: it refuses, naming why, before any write.
 *
 * Called from the SERVICES (calculatePayrollRun, approvePayrollRun and previewPayrollApproval, postPayrollRunJournal,
 * reopenPayrollRun, getPayslips; EF adds emp201Service and irp5DataService, BF its bank-file service), never from a
 * route, so MCP tools and bureau paths are covered too (tests/unit/services/payroll/payrollRunKindGuardCensus.test.ts).
 *
 * Columns and tables that do not exist yet are read without naming them, so this file runs on today's schema and on
 * every later one: a column through `to_jsonb(row) ->> 'name'` (NULL while absent), a table through
 * `to_regclass` with a CASE that never plans the query while the table is absent (query_to_xml runs it only then).
 * Each later PR lifts exactly its own clause, in its own release. Contract for those PRs (the names read here):
 *   payroll_employee_components.db_member_category_factor / .rate_multiplier (DBF, RI), quantity_unit 'km' (RI);
 *   payroll_garnishee_orders(company_id, employee_id, status) and payroll_garnishee_deductions(run_id) (GA). An order
 *   counts unless its status is cancelled, completed, satisfied, withdrawn or ended; a missing key counts (fails closed).
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';

export type RunKindAction = 'calculate' | 'approve' | 'post' | 'reopen' | 'payslip' | 'emp201' | 'irp5' | 'bank_file';

/** The tax statuses this release costs (migration 967; PSP adds personal_service_provider). */
export const KNOWN_TAX_STATUSES = ['employee', 'director', 'independent_contractor'] as const;

export type RunKindClause =
  | 'frequency' | 'run_kind' | 'tax_status' | 'employee_frequency' | 'assignment' | 'garnishee_order' | 'garnishee_deduction';

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

/** Which clauses each action judges. Costing reads assignments and orders; every action meets the run's shape. */
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
      SELECT h.id, h.company_id, h.pay_frequency, h.run_kind, h.period_start, h.period_end
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
    SELECT r.pay_frequency, r.run_kind,
      (SELECT array_agg(p.employee_number ORDER BY p.employee_number) FROM people p
        WHERE p.tax_status IS NULL OR p.tax_status <> ALL(${[...KNOWN_TAX_STATUSES]}::text[])) AS unknown_status,
      (SELECT array_agg(p.employee_number ORDER BY p.employee_number) FROM people p
        WHERE p.on_line AND p.pay_frequency IS DISTINCT FROM r.pay_frequency) AS other_frequency,
      (SELECT array_agg(DISTINCT p.employee_number) FROM people p
         JOIN payroll_employee_components c ON c.employee_id = p.id
        WHERE c.superseded_at IS NULL
          AND c.effective_from <= r.period_end AND (c.effective_to IS NULL OR c.effective_to >= r.period_start)
          AND (to_jsonb(c) ->> 'db_member_category_factor' IS NOT NULL
               OR to_jsonb(c) ->> 'rate_multiplier' IS NOT NULL
               OR to_jsonb(c) ->> 'quantity_unit' = 'km')) AS odd_assignments,
      CASE WHEN to_regclass('public.payroll_garnishee_orders') IS NULL THEN 0
           ELSE (xpath('/row/n/text()', query_to_xml(format(
             'SELECT count(*) AS n FROM public.payroll_garnishee_orders g'
             || ' WHERE COALESCE(to_jsonb(g) ->> ''company_id'', %L) = %L'
             || ' AND (NOT (to_jsonb(g) ? ''employee_id'') OR to_jsonb(g) ->> ''employee_id'' = ANY (%L::text[]))'
             || ' AND COALESCE(to_jsonb(g) ->> ''status'', '''') NOT IN'
             || ' (''cancelled'', ''completed'', ''satisfied'', ''withdrawn'', ''ended'')',
             r.company_id::text, r.company_id::text, (SELECT array_agg(p.id::text) FROM people p)),
             false, true, '')))[1]::text::int END AS garnishee_orders,
      CASE WHEN to_regclass('public.payroll_garnishee_deductions') IS NULL THEN 0
           ELSE (xpath('/row/n/text()', query_to_xml(format(
             'SELECT count(*) AS n FROM public.payroll_garnishee_deductions d'
             || ' WHERE NOT (to_jsonb(d) ? ''run_id'') OR to_jsonb(d) ->> ''run_id'' = %L', r.id::text),
             false, true, '')))[1]::text::int END AS garnishee_deductions
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
  if (row.pay_frequency !== 'monthly') {
    reasons.push({ clause: 'frequency', detail: `it is a ${String(row.pay_frequency)} run, and only monthly runs are supported` });
  }
  if (row.run_kind !== 'regular') {
    reasons.push({ clause: 'run_kind', detail: `it is an ${String(row.run_kind).replace('_', '-')} run, and only regular runs are supported` });
  }
  if (Number(row.garnishee_deductions) > 0) {
    reasons.push({ clause: 'garnishee_deduction', detail: 'it carries garnishee deductions' });
  }
  if (action !== 'reopen' && names(row.unknown_status)) {
    reasons.push({ clause: 'tax_status', detail: `employees ${names(row.unknown_status)} have a tax status this version does not know` });
  }
  if (action !== 'reopen' && action !== 'calculate' && names(row.other_frequency)) {
    reasons.push({ clause: 'employee_frequency', detail: `employees ${names(row.other_frequency)} are not paid at the run's frequency` });
  }
  if (COSTING.has(action) && names(row.odd_assignments)) {
    reasons.push({ clause: 'assignment', detail: `employees ${names(row.odd_assignments)} have pay components with a defined-benefit factor, an overtime multiplier or travel km` });
  }
  if (COSTING.has(action) && Number(row.garnishee_orders) > 0) {
    reasons.push({ clause: 'garnishee_order', detail: 'an employee on it has an active garnishee order' });
  }
  return reasons;
}
