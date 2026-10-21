/**
 * Severance (3901) paid in the pay run at its SARS directive's figures.
 * Audit 2026-10-18 P3.
 *
 * SARS PAYE-GEN-01-G21 (2027) Revision 1, "Tax directives" (p. 15: "Employers
 * may under no circumstances deviate from the instructions of the directive")
 * and "Lump sums by employers – severance benefits" (p. 22: paragraph 9(3) of
 * the Fourth Schedule requires the directive application before the lump sum
 * is paid; the tax is reported under 4115, the amount under 3901)
 * (https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf).
 *
 * A directive is AVAILABLE to a run when it is an approved 'severance'
 * directive for the employee, in force on the last day of the run's period,
 * with a tax figure, and its tax_directive_payments row is absent or is this
 * run's own claim. A row of any other kind — the stand-alone payment
 * (taxDirectivePaymentService) or another run's claim — has paid it. A run
 * claims the directive only when it is approved (payrollRunDirectiveClaim.ts),
 * so a draft, however often recalculated, consumes nothing; a reopened run
 * keeps its claim until it is approved again without the line.
 *
 * Every query is scoped by company_id.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { runHasPaid } from './payrollTerminationPaidCheck';
import { mapPayrollEmployeeRow } from './payrollEmployeeService';
import type { EmployeeComponent, PayrollEmployee, PayrollPeriod } from './payrollTypes';

/** The breakdown id of a severance line paid under a directive. Not a `synthetic:termination:` id: see payrollTerminationPaidCheck. */
export const SEVERANCE_DIRECTIVE_COMPONENT_ID = 'synthetic:directive:severance';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The PAYE a directive prescribes on its gross: the rate when one is set, else
 * the fixed amount; null when it carries neither, or a figure below nil or
 * above the gross (the directive is then not payable). The one rule for both the
 * run and the stand-alone payment, so the two cannot pay different tax.
 */
export function directivePaye(row: DbRow): number | null {
  const gross = round2(Number(row.amount));
  const paye = row.tax_rate != null ? round2(gross * Number(row.tax_rate))
    : row.tax_amount != null ? round2(Number(row.tax_amount))
    : null;
  // A tax figure outside 0..gross is not a directive anyone can pay: nil net or negative tax.
  return paye == null || paye < 0 || paye > gross ? null : paye;
}

export interface SeveranceDirective {
  id: string;
  number: string | null;
  gross: number;
  paye: number;
  effectiveDate: string;
}

function mapDirective(r: DbRow): SeveranceDirective {
  return {
    id: String(r.id),
    number: r.directive_number == null ? null : String(r.directive_number),
    gross: round2(Number(r.amount)),
    paye: directivePaye(r)!, // callers pass only payable rows (findSeveranceDirectiveForRun)
    effectiveDate: fmtDate(r.effective_date),
  };
}

export interface SeveranceDirectiveLookup {
  /** The directive this run may pay, earliest first, or null. */
  available: SeveranceDirective | null;
  /** True when an approved severance directive for the employee has been paid by something else. */
  paidElsewhere: boolean;
  /** An approved, unpaid directive whose tax figure cannot be paid (directivePaye null), when none is available. */
  unpayable: { id: string; number: string | null } | null;
}

export async function findSeveranceDirectiveForRun(
  companyId: string,
  employeeId: string,
  runId: string,
  period: PayrollPeriod,
): Promise<SeveranceDirectiveLookup> {
  const rows = (await sql`
    WITH p AS (SELECT (make_date(${period.year}::int, ${period.month}::int, 1) + INTERVAL '1 month - 1 day')::date AS last_day)
    SELECT d.id, d.directive_number, d.amount, d.tax_rate, d.tax_amount, d.effective_date,
           (tdp.id IS NOT NULL AND (tdp.payroll_run_id IS NULL OR tdp.payroll_run_id <> ${runId}::uuid)) AS paid_elsewhere
    FROM tax_directives d
    CROSS JOIN p
    LEFT JOIN tax_directive_payments tdp ON tdp.tax_directive_id = d.id AND tdp.company_id = d.company_id
    WHERE d.company_id = ${companyId}::uuid
      AND d.employee_id = ${employeeId}::uuid
      AND d.directive_type = 'severance'
      AND d.status = 'approved'
      AND d.effective_date <= p.last_day
      AND (d.expiry_date IS NULL OR d.expiry_date >= p.last_day)
      AND (d.tax_rate IS NOT NULL OR d.tax_amount IS NOT NULL)
    ORDER BY d.effective_date, d.created_at, d.id
  `) as DbRow[];
  const free = rows.find(r => r.paid_elsewhere !== true && directivePaye(r) != null);
  const bad = free ? undefined : rows.find(r => r.paid_elsewhere !== true);
  return {
    available: free ? mapDirective(free) : null,
    paidElsewhere: rows.some(r => r.paid_elsewhere === true),
    unpayable: bad ? { id: String(bad.id), number: bad.directive_number == null ? null : String(bad.directive_number) } : null,
  };
}

/**
 * Employees who left BEFORE this run's period and have a severance directive
 * available to it: the first run after the directive is approved pays them the
 * severance line alone (decided 2026-10-20). Disjoint from
 * listPayrollRunEmployees, which takes nobody whose end_date is before the
 * period. Availability is findSeveranceDirectiveForRun's, the one statement of
 * it; this query only narrows the leavers to those with an approved severance
 * directive at all.
 */
export async function listSeveranceOnlyRunEmployees(
  companyId: string,
  runId: string,
  period: PayrollPeriod,
): Promise<PayrollEmployee[]> {
  const rows = (await sql`
    SELECT e.* FROM payroll_employees e
    WHERE e.company_id = ${companyId}::uuid
      AND e.end_date < make_date(${period.year}::int, ${period.month}::int, 1)
      AND EXISTS (
        SELECT 1 FROM tax_directives d
        WHERE d.company_id = e.company_id AND d.employee_id = e.id
          AND d.directive_type = 'severance' AND d.status = 'approved'
          -- Narrows only: leavers whose every directive is paid drop out here;
          -- findSeveranceDirectiveForRun below decides.
          AND NOT EXISTS (
            SELECT 1 FROM tax_directive_payments tdp
            WHERE tdp.company_id = d.company_id AND tdp.tax_directive_id = d.id
              AND (tdp.payroll_run_id IS NULL OR tdp.payroll_run_id <> ${runId}::uuid)
          )
      )
    ORDER BY e.last_name, e.first_name
  `) as DbRow[];
  const out: PayrollEmployee[] = [];
  for (const row of rows) {
    const employee = mapPayrollEmployeeRow(row);
    // An unpayable directive too, so its warning is raised (payrollRunTermination.severanceOnlyComponents).
    const { available, unpayable } = await findSeveranceDirectiveForRun(companyId, employee.id, runId, period);
    if (available || unpayable) out.push(employee);
  }
  return out;
}

/**
 * A run other than `runId` that already PAID this employee severance (3901, the
 * severance directive's own code) under no directive — captured by hand, before
 * this run or before P3. Other lump-sum codes (3915, 3920, …) are other
 * benefits and do not stand in for severance. "Paid" is runHasPaid's (P4): approved or paid, or reopened with
 * its journal still in the ledger. A directive approved afterwards must not pay
 * it a second time (payrollRunTermination, SEVERANCE_CAPTURED_AS_COMPONENT).
 * Unbounded in time on purpose: any such payment blocks every later severance
 * directive for the employee, and the warning says which run, so a human
 * decides whether the directive replaces it.
 */
export async function findHandMadeLumpSumPaid(
  companyId: string,
  employeeId: string,
  runId: string,
): Promise<{ year: number; month: number; name: string } | null> {
  const rows = (await sql`
    SELECT h.period_year, h.period_month, h.status, h.journal_entry_id, item->>'componentName' AS name
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    CROSS JOIN LATERAL jsonb_array_elements(l.component_breakdown) AS item
    WHERE h.company_id = ${companyId}::uuid
      AND l.employee_id = ${employeeId}::uuid
      AND h.id <> ${runId}::uuid
      AND (h.status IN ('approved', 'paid') OR h.journal_entry_id IS NOT NULL)
      AND regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3901'
      AND item->'directive' IS NULL
    ORDER BY h.period_year, h.period_month
  `) as DbRow[];
  const inForce = new Map<string, Promise<boolean>>();
  for (const r of rows) {
    if (await runHasPaid(companyId, String(r.status), r.journal_entry_id, inForce)) {
      return { year: Number(r.period_year), month: Number(r.period_month), name: String(r.name) };
    }
  }
  return null;
}

/** The run line component that pays `d`: code 3901, not UIF- or SDL-leviable, PAYE as on the directive. */
export function severanceDirectiveComponent(d: SeveranceDirective): EmployeeComponent {
  return {
    component: {
      id: SEVERANCE_DIRECTIVE_COMPONENT_ID,
      name: `Severance Pay (SARS directive ${d.number ?? d.id.slice(0, 8)})`,
      sarsSourceCode: '3901',
      componentType: 'earning',
      isTaxable: true,
      // Severance benefits are not UIF- or SDL-leviable, as the synthetic
      // severance component (payrollTerminationService) has always held.
      isUifApplicable: false,
      isSdlApplicable: false,
    },
    amount: d.gross,
    directive: { id: d.id, number: d.number, paye: d.paye },
  };
}
