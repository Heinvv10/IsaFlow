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
 * FINAL RUNS ONLY. A draft or cancelled run is not remuneration anybody
 * was paid, and a certificate built from one would be wrong. Final is the one
 * fragment `payRunFinalSql` (approved or paid AND an approval time), the same
 * the EMP201 uses, so the two cannot disagree about which runs count. Runs
 * excluded on that basis are COUNTED and named, because "this employee earned
 * nothing" and "this employee's runs were never approved" are different facts;
 * an approved run with no approval time is also named in `warnings`.
 *
 * The SA tax year runs 1 March (taxYear − 1) to 28/29 February (taxYear).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { listNotFinalDeclaredRuns, notFinalRunWarning } from './payRunNotFinal';
import { assertRunKindSupported } from './payrollRunKindGuard';
import { payeTaxYearBounds } from '@/modules/accounting/utils/payeTaxYear';
import { listCertificateLumpSums } from './directivePaymentFiling';
import { allowanceCertificateFields, listRunAllowanceFiling } from './payrollAllowanceFiling';
import { listRunNonCashBenefits, listRunUnflaggedFringe, unflaggedFringeWarning } from './payrollNonCashFiling';
import type { Irp5EmployeeTotals, Irp5Exclusion, Irp5Dataset } from './irp5DataTypes';

type Row = DbRow;

export type { Irp5EmployeeTotals, Irp5Exclusion, Irp5Dataset } from './irp5DataTypes';

/** Excluded employees are listed individually up to this many; beyond it the
 *  envelope reports `excludedTotal` with `truncatedExcludedRows` set. */
const EXCLUDED_SAMPLE_CAP = 200;

/** 1 March of the prior calendar year to the last day of February in taxYear. */
export function saTaxYearBounds(taxYear: number): { start: string; end: string } {
  return payeTaxYearBounds(taxYear);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

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

  // Wave 6 FQa/EF: every final run the certificates sum is one this release can certify (monthly, regular), or the
  // whole read is refused by name (409) rather than certified as if it were.
  const finalRuns = (await sql`
    SELECT prh.id::text AS id FROM payroll_run_headers prh
     WHERE prh.company_id = ${companyId}::UUID AND ${sql.unsafe(payRunFinalSql('prh'))}
       AND make_date(prh.period_year, prh.period_month, 1) BETWEEN ${start}::DATE AND ${end}::DATE
       AND (${employeeId}::UUID IS NULL
            OR EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.run_id = prh.id AND l.employee_id = ${employeeId}::UUID))
  `) as Row[];
  for (const runId of finalRuns.map((r) => String(r.id))) await assertRunKindSupported(companyId, runId, 'irp5');

  const rows = (await sql`
    SELECT
      e.id, e.employee_number, e.first_name, e.last_name, e.id_number, e.tax_number,
      SUM(prl.gross_pay)::NUMERIC      AS gross_pay,
      SUM(prl.taxable_income)::NUMERIC AS taxable_income,
      SUM(COALESCE(prl.retirement_deduction, 0))::NUMERIC AS retirement_deduction,
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
      AND ${sql.unsafe(payRunFinalSql('prh'))}
      AND make_date(prh.period_year, prh.period_month, 1)
          BETWEEN ${start}::DATE AND ${end}::DATE
      AND (${employeeId}::UUID IS NULL OR e.id = ${employeeId}::UUID)
    GROUP BY e.id, e.employee_number, e.first_name, e.last_name, e.id_number, e.tax_number
    ORDER BY e.last_name, e.first_name, e.id
  `) as Row[];

  // Employees whose remuneration in this tax year sits ONLY on non-final
  // runs. Their pay is real and does not belong on a certificate, so each is
  // named rather than silently absent.
  //
  // Per EMPLOYEE, not per run: `rows` are employees, and the completeness
  // identity only means something if both sides count the same kind of thing.
  // This was one aggregate row standing for every non-declarable run, which
  // satisfied the arithmetic while reporting a universe of 1 for a run carrying
  // ten people.
  const excludedRowsRaw = (await sql`
    SELECT e.id,
           e.employee_number,
           e.first_name,
           e.last_name,
           COALESCE(SUM(prl.gross_pay), 0)::NUMERIC AS gross,
           COUNT(DISTINCT prh.id)::INT             AS runs
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees e ON e.id = prl.employee_id
    WHERE prh.company_id = ${companyId}::UUID
      AND e.company_id = ${companyId}::UUID
      AND NOT ${sql.unsafe(payRunFinalSql('prh'))}
      AND make_date(prh.period_year, prh.period_month, 1)
          BETWEEN ${start}::DATE AND ${end}::DATE
      AND (${employeeId}::UUID IS NULL OR e.id = ${employeeId}::UUID)
      -- Anyone who ALSO has a final run is already a certificate row, and
      -- counting them on both sides would overstate the universe.
      AND NOT EXISTS (
        SELECT 1
        FROM payroll_run_lines d
        JOIN payroll_run_headers dh ON dh.id = d.run_id
        WHERE d.employee_id = e.id
          AND dh.company_id = ${companyId}::UUID
          AND ${sql.unsafe(payRunFinalSql('dh'))}
          AND make_date(dh.period_year, dh.period_month, 1)
              BETWEEN ${start}::DATE AND ${end}::DATE
      )
    GROUP BY e.id, e.employee_number, e.first_name, e.last_name
    ORDER BY e.last_name, e.first_name, e.id
  `) as Row[];

  // Directives paid outside payroll are in no run line: their gross and PAYE are
  // added here, and an employee paid ONLY that way gets a row of their own.
  const { byEmployee: lumpSums, standaloneTotals } = await listCertificateLumpSums(companyId, { start, end }, employeeId);
  const fringeBenefits = await listRunNonCashBenefits(companyId, { start, end }, employeeId);
  const unflagged = await listRunUnflaggedFringe(companyId, { start, end }, employeeId);
  const allowances = await listRunAllowanceFiling(companyId, { start, end }, employeeId);
  const notFinal = await listNotFinalDeclaredRuns(companyId, start, end, employeeId);
  const standaloneIds = [...standaloneTotals.keys()];
  const withRuns = new Set(rows.map(r => String(r.id)));
  const onlyStandalone = standaloneIds.filter(id => !withRuns.has(id));
  if (onlyStandalone.length > 0) {
    rows.push(...(await sql`
      SELECT id, employee_number, first_name, last_name, id_number, tax_number
      FROM payroll_employees
      WHERE company_id = ${companyId}::UUID AND id = ANY(${onlyStandalone}::UUID[])
    `) as Row[]);
    rows.sort((a, b) => String(a.last_name ?? '').localeCompare(String(b.last_name ?? ''))
      || String(a.first_name ?? '').localeCompare(String(b.first_name ?? '')) || String(a.id).localeCompare(String(b.id)));
  }
  const mapped: Irp5EmployeeTotals[] = rows.map((r) => {
    const t = standaloneTotals.get(String(r.id)) ?? { gross: 0, paye: 0 };
    return {
      employeeId: String(r.id),
      employeeNumber: String(r.employee_number ?? ''),
      firstName: String(r.first_name ?? ''),
      lastName: String(r.last_name ?? ''),
      idNumber: maskTail(r.id_number, reveal),
      taxNumber: maskTail(r.tax_number, reveal),
      identityNumbersMasked: !reveal,
      grossSalary: round2((Number(r.gross_pay) || 0) + t.gross),
      taxableIncome: round2(
        (Number(r.taxable_income) || 0) - (Number(r.retirement_deduction) || 0) + t.gross,
      ),
      paye: round2((Number(r.paye) || 0) + t.paye),
      uifEmployee: Number(r.uif_employee) || 0,
      uifEmployer: Number(r.uif_employer) || 0,
      sdl: Number(r.sdl) || 0,
      eti: Number(r.eti) || 0,
      netPay: round2((Number(r.net_pay) || 0) + t.gross - t.paye),
      runsIncluded: Number(r.runs_included) || 0,
      lumpSums: lumpSums.get(String(r.id)) ?? [],
      fringeBenefits: fringeBenefits.get(String(r.id)) ?? [],
      cashAllowances: allowanceCertificateFields(allowances.get(String(r.id))).cashAllowances,
      paye4582: allowanceCertificateFields(allowances.get(String(r.id))).paye4582 ?? null,
    };
  });

  // An employee with a stand-alone payment is a certificate row, not an exclusion.
  const excludedRows = excludedRowsRaw.filter(r => !standaloneTotals.has(String(r.id)));
  const excludedTotal = excludedRows.length;
  const excluded: Irp5Exclusion[] = excludedRows
    .slice(0, EXCLUDED_SAMPLE_CAP)
    .map((r) => ({
      id: String(r.id),
      reason: 'run_not_declarable',
      detail: `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim() +
        ` (${String(r.employee_number ?? '')}) has pay on ${Number(r.runs) || 0} run(s) in this tax year, none of them final (approved or paid, with an approval time), so none of it is on a certificate.`,
      amount: Number(r.gross) || 0,
    }));

  // The universe, derived INDEPENDENTLY of the two queries above rather than as
  // their sum. `mapped.length + excludedTotal` is the arithmetic buildEnvelope
  // then checks, so stating it that way asserts an identity that cannot fail:
  // it would stay true even for a bug that dropped an employee from BOTH the
  // certificate query and the exclusion query. Counting everyone with any pay
  // in the tax year, from one query that cares about neither status nor
  // declarability, is a claim the envelope can actually falsify.
  // Plus anyone paid a directive outside payroll in the year (no run line).
  const [universe] = (await sql`
    SELECT COUNT(*)::INT AS employees FROM (
      SELECT prl.employee_id
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
      JOIN payroll_employees e ON e.id = prl.employee_id
      WHERE prh.company_id = ${companyId}::UUID
        AND e.company_id = ${companyId}::UUID
        AND make_date(prh.period_year, prh.period_month, 1)
            BETWEEN ${start}::DATE AND ${end}::DATE
        AND (${employeeId}::UUID IS NULL OR e.id = ${employeeId}::UUID)
      UNION
      SELECT unnest(${standaloneIds}::UUID[])
    ) u
  `) as Row[];

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
    universeTotal: Number(universe?.employees ?? 0),
    excludedTotal,
    excluded,
    postedThrough,
    warnings: [
      ...notFinal.map((r) => notFinalRunWarning(r, 'IRP5')),
      ...rows.filter((r) => unflagged.has(String(r.id))).map((r) =>
        unflaggedFringeWarning(`${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim(), unflagged.get(String(r.id))!)),
    ],
  };
}
