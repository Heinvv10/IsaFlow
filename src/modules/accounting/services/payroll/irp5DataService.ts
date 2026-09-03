/**
 * Per-employee annual payroll totals for an IRP5 / IT3(a), for one SA tax year.
 *
 * BUILD, not a wrap. `irp5Service#buildIRP5Certificate` is real and takes an
 * `IRP5EmployeeData`, but NOTHING assembled one — the only caller of that module
 * is `pages/api/accounting/sars/emp501.ts`, which aggregates `payroll_runs` and
 * `payslips`, two tables DROPPED in migration 384. That endpoint therefore
 * throws 42P01 on every call. This service is the aggregate it should have had,
 * and it now feeds both.
 *
 * TENANT SCOPE. `payroll_run_lines` has no `company_id` of its own. It is
 * scopable only through `payroll_run_headers`, so the join to the header IS the
 * tenant boundary: it is INNER and the company predicate lives in WHERE, never
 * in an outer join's ON clause where it would restrict nothing.
 *
 * DECLARABLE RUNS ONLY. A draft or cancelled run is not remuneration anybody
 * was paid, and a certificate built from one would be wrong. The statuses come
 * from `EMP201_DECLARABLE_STATUSES` so the EMP201 and the IRP5 cannot disagree
 * about which runs count. Runs excluded on that basis are COUNTED and named,
 * because "this employee earned nothing" and "this employee's runs were never
 * approved" are different facts.
 *
 * The SA tax year runs 1 March (taxYear − 1) to 28/29 February (taxYear).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

type Row = DbRow;

export interface Irp5EmployeeTotals {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  /** Masked to the last four digits unless the caller asked to reveal them. */
  idNumber: string | null;
  taxNumber: string | null;
  identityNumbersMasked: boolean;
  grossSalary: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
  runsIncluded: number;
}

export interface Irp5Exclusion {
  id: string;
  reason: string;
  detail?: string;
  amount?: number;
}

export interface Irp5Dataset {
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  rows: Irp5EmployeeTotals[];
  rowsTotal: number;
  universeTotal: number;
  excluded: Irp5Exclusion[];
  postedThrough: string | null;
}

/** 1 March of the prior calendar year to the last day of February in taxYear. */
export function saTaxYearBounds(taxYear: number): { start: string; end: string } {
  const isLeap =
    (taxYear % 4 === 0 && taxYear % 100 !== 0) || taxYear % 400 === 0;
  return {
    start: `${taxYear - 1}-03-01`,
    end: `${taxYear}-02-${isLeap ? '29' : '28'}`,
  };
}

function maskTail(value: unknown, reveal: boolean): string | null {
  if (value == null) return null;
  const s = String(value);
  if (reveal) return s;
  return s.length <= 4 ? '*'.repeat(s.length) : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}

export async function getIrp5EmployeeTotals(
  companyId: string,
  taxYear: number,
  opts: { revealIdentityNumbers?: boolean; employeeId?: string } = {},
): Promise<Irp5Dataset> {
  const { start, end } = saTaxYearBounds(taxYear);
  const reveal = opts.revealIdentityNumbers === true;
  const employeeId = opts.employeeId ?? null;
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];

  const rows = (await sql`
    SELECT
      e.id, e.employee_number, e.first_name, e.last_name, e.id_number, e.tax_number,
      SUM(prl.gross_pay)::NUMERIC      AS gross_pay,
      SUM(prl.taxable_income)::NUMERIC AS taxable_income,
      SUM(prl.paye)::NUMERIC           AS paye,
      SUM(prl.uif_employee)::NUMERIC   AS uif_employee,
      SUM(prl.uif_employer)::NUMERIC   AS uif_employer,
      SUM(prl.sdl)::NUMERIC            AS sdl,
      SUM(prl.eti)::NUMERIC            AS eti,
      SUM(prl.net_pay)::NUMERIC        AS net_pay,
      COUNT(DISTINCT prh.id)::INT      AS runs_included,
      MAX(prl.created_at)              AS posted_through
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees e ON e.id = prl.employee_id
    WHERE prh.company_id = ${companyId}::UUID
      AND e.company_id = ${companyId}::UUID
      AND prh.status = ANY(${declarable}::TEXT[])
      AND make_date(prh.period_year, prh.period_month, 1)
          BETWEEN ${start}::DATE AND ${end}::DATE
      AND (${employeeId}::UUID IS NULL OR e.id = ${employeeId}::UUID)
    GROUP BY e.id, e.employee_number, e.first_name, e.last_name, e.id_number, e.tax_number
    ORDER BY e.last_name, e.first_name, e.id
  `) as Row[];

  // Runs inside the tax year that are NOT declarable. Their remuneration is
  // real and does not belong on a certificate, so it is named rather than
  // silently absent.
  const [nonDeclarable] = (await sql`
    SELECT COUNT(*)::INT AS runs, COALESCE(SUM(total_gross), 0) AS gross
    FROM payroll_run_headers
    WHERE company_id = ${companyId}::UUID
      AND NOT (status = ANY(${declarable}::TEXT[]))
      AND make_date(period_year, period_month, 1) BETWEEN ${start}::DATE AND ${end}::DATE
  `) as Row[];

  const mapped: Irp5EmployeeTotals[] = rows.map((r) => ({
    employeeId: String(r.id),
    employeeNumber: String(r.employee_number ?? ''),
    firstName: String(r.first_name ?? ''),
    lastName: String(r.last_name ?? ''),
    idNumber: maskTail(r.id_number, reveal),
    taxNumber: maskTail(r.tax_number, reveal),
    identityNumbersMasked: !reveal,
    grossSalary: Number(r.gross_pay) || 0,
    taxableIncome: Number(r.taxable_income) || 0,
    paye: Number(r.paye) || 0,
    uifEmployee: Number(r.uif_employee) || 0,
    uifEmployer: Number(r.uif_employer) || 0,
    sdl: Number(r.sdl) || 0,
    eti: Number(r.eti) || 0,
    netPay: Number(r.net_pay) || 0,
    runsIncluded: Number(r.runs_included) || 0,
  }));

  const excluded: Irp5Exclusion[] = [];
  const nonDeclarableRuns = Number(nonDeclarable?.runs ?? 0);
  if (nonDeclarableRuns > 0) {
    excluded.push({
      id: 'non_declarable_runs',
      reason: 'run_not_declarable',
      detail: `${nonDeclarableRuns} payroll runs fall in this tax year but are not in a declarable status (${declarable.join(', ')}), so their remuneration is not on any certificate.`,
      amount: Number(nonDeclarable?.gross ?? 0),
    });
  }

  const postedThrough = rows
    .map((r) => (r.posted_through ? new Date(String(r.posted_through)).toISOString() : null))
    .filter((v): v is string => v !== null)
    .sort()
    .slice(-1)[0] ?? null;

  return {
    taxYear,
    periodStart: start,
    periodEnd: end,
    rows: mapped,
    rowsTotal: mapped.length,
    universeTotal: mapped.length + excluded.length,
    excluded,
    postedThrough,
  };
}
