/**
 * An employee's earlier periods of the tax year, for the cumulative PAYE
 * (payeCumulative.ts; PAYE 4a follow-ups G4).
 *
 * From the employee's lines on DECLARABLE runs (EMP201_DECLARABLE_STATUSES:
 * approved, paid) of the same SA tax year (March to February) whose period is
 * BEFORE the run being calculated, so the run itself, a reopened run (no longer
 * declarable) and any later period are never in it. Lines are what the
 * employee was paid and what EMP201 and the IRP5 declare, so the cumulative
 * deduction trues up to exactly those.
 *
 * - periods: lines with periodic pay (a severance-only line has none);
 * - periodicTaxable / annualPayments: the line's periodic_taxable /
 *   annual_taxable (migration 913). A line written before 913 has NULLs, and
 *   its split is derived from the stored breakdown: annual payments = its
 *   taxable 3605 items, netted and floored at nil, capped at taxable_income;
 *   periodic = taxable_income less that;
 * - tablePaye: the line's PAYE less its directive PAYE (lump sums are taxed
 *   only at their directive's figures, outside the tables);
 * - medicalCredit: the medical scheme fees tax credit the lines recorded
 *   (medical_credit, migration 926; a line before it recorded none, so the
 *   next line's record carries its credit: payeCumulative); likewise
 *   additionalMedicalCredit (additional_medical_credit, the 65+ credit);
 * - medicalSchemeFees: the fees deducted on those lines (loadMedicalRecord:
 *   medical_scheme_fees, else the breakdown's deductions coded 4005);
 * - retirementContributions / retirementDeduction / donations: by the one
 *   rule for them (payrollRetirementRecord, migration 948, PAYE 4c): a line
 *   before 948 from its breakdown. The old calculator took its taxable-flagged
 *   contributions off periodic pay first and then annual payments, so the add-back
 *   restores that same split; a restored periodic amount counts as a period again
 *   (yearToDatePeriods). Production had no such line in
 *   tax year 2027 (read-only census 2026-10-26: 0 of 167 lines).
 *
 * Every query is scoped by company_id.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { PAYE_TAX_YEAR_START_MONTH } from '@/modules/accounting/utils/payeTaxYear';
import { getTaxYear } from './taxTables';
import type { PayeYearToDate, PayrollPeriod, ValidationResult } from './payrollTypes';
import { loadMedicalRecord } from './payrollMedicalRecord';
import { loadRetirementRecord } from './payrollRetirementRecord';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** By employee id; an employee with no earlier line this tax year is absent (none to date). */
export async function loadPayeYearToDate(
  companyId: string,
  runId: string,
  period: PayrollPeriod,
  employeeIds: string[],
): Promise<Map<string, PayeYearToDate>> {
  if (employeeIds.length === 0) return new Map();
  const taxYear = getTaxYear(period.month, period.year);
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    WITH split AS (
      SELECT l.id AS line_id, l.employee_id, l.paye, b.directive_paye, l.medical_credit, l.additional_medical_credit,
             COALESCE(l.annual_taxable, LEAST(b.annual_3605, l.taxable_income)) AS annual,
             COALESCE(l.periodic_taxable, l.taxable_income - LEAST(b.annual_3605, l.taxable_income)) AS periodic,
             b.annual_3605
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM((item->'directive'->>'paye')::numeric) FILTER (WHERE item->'directive' IS NOT NULL), 0) AS directive_paye,
               GREATEST(COALESCE(SUM((item->>'amount')::numeric) FILTER (
                 WHERE regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3605'
                   AND (item->>'isTaxable')::boolean), 0), 0) AS annual_3605
        FROM jsonb_array_elements(l.component_breakdown) AS item
      ) b
      WHERE h.company_id = ${companyId}::uuid
        AND h.id <> ${runId}::uuid
        AND h.status = ANY(${declarable}::text[])
        AND make_date(h.period_year, h.period_month, 1) >= make_date(${taxYear - 1}::int, ${PAYE_TAX_YEAR_START_MONTH}::int, 1)
        AND make_date(h.period_year, h.period_month, 1) < make_date(${period.year}::int, ${period.month}::int, 1)
        AND l.employee_id = ANY(${employeeIds}::uuid[])
    )
    SELECT employee_id,
           COUNT(*) FILTER (WHERE periodic > 0)::int AS periods,
           -- Lines with no stored periodic pay: a pre-948 one may have had it before its taxable retirement deduction.
           jsonb_object_agg(line_id::text, periodic) FILTER (WHERE periodic <= 0) AS unpaid_lines,
           jsonb_object_agg(line_id::text, jsonb_build_object(
             'periodic', periodic, 'annual', annual, 'annualGross', annual_3605
           )) AS taxable_splits,
           SUM(periodic)::numeric AS periodic,
           SUM(annual)::numeric AS annual,
           SUM(paye - directive_paye)::numeric AS table_paye,
           -- SUM skips a line written before migration 926 (NULL: recorded nothing).
           SUM(medical_credit)::numeric AS medical_credit,
           SUM(additional_medical_credit)::numeric AS additional_medical_credit
    FROM split
    GROUP BY employee_id
  `) as DbRow[];
  // The same lines' medical scheme fees and retirement fund contributions, by the one rule for each (a line
  // before 926 / 948 from its breakdown).
  const before = {
    start: `${taxYear - 1}-03-01`,
    end: period.month === 1 ? `${period.year - 1}-12-01` : `${period.year}-${String(period.month - 1).padStart(2, '0')}-01`,
  };
  const fees = await loadMedicalRecord(companyId, before, employeeIds);
  const retirement = await loadRetirementRecord(companyId, before, employeeIds);
  return new Map(rows.map(r => {
    const fund = retirement.get(String(r.employee_id));
    const restored = restoreLegacyTaxableSplit(
      (r.taxable_splits ?? {}) as Record<string, unknown>,
      fund?.legacyTaxableByLine ?? {},
    );
    return [String(r.employee_id), {
      periods: yearToDatePeriods(Number(r.periods), (r.unpaid_lines ?? {}) as Record<string, unknown>, restored.periodicByLine),
      periodicTaxable: round2(Number(r.periodic) + restored.periodic),
      annualPayments: round2(Number(r.annual) + restored.annual),
      tablePaye: round2(Number(r.table_paye)),
      medicalCredit: round2(Number(r.medical_credit)),
      additionalMedicalCredit: round2(Number(r.additional_medical_credit)),
      medicalSchemeFees: fees.get(String(r.employee_id))?.fees ?? 0,
      retirementContributions: fund?.contributions ?? 0,
      retirementDeduction: fund?.deduction ?? 0,
      donations: fund?.donations ?? 0,
    }];
  }));
}

function restoreLegacyTaxableSplit(
  taxableSplits: Record<string, unknown>,
  legacyTaxableByLine: Record<string, number>,
): { periodic: number; annual: number; periodicByLine: Record<string, number> } {
  let periodic = 0;
  let annual = 0;
  const periodicByLine: Record<string, number> = {};
  for (const [lineId, deduction] of Object.entries(legacyTaxableByLine)) {
    const split = (taxableSplits[lineId] ?? {}) as Record<string, unknown>;
    // The old calculator consumed periodic pay first. Therefore any gap between
    // the gross 3605 amount and its stored annual amount is the deduction's
    // excess; only the remainder can be restored to periodic remuneration.
    const annualGap = Math.max(0, Number(split.annualGross) - Number(split.annual));
    const annualRestored = Math.min(deduction, annualGap);
    const periodicRestored = Math.max(0, deduction - annualRestored);
    annual += annualRestored;
    periodic += periodicRestored;
    if (periodicRestored > 0) periodicByLine[lineId] = periodicRestored;
  }
  return { periodic, annual, periodicByLine };
}

/**
 * The periods to date: the lines with stored periodic pay, plus those without
 * whose pre-948 taxable retirement contributions restore periodic pay (the old
 * calculator took deductions off periodic pay first, so a contribution as large
 * as the pay left it nil). A bonus-only or severance-only line stays no period.
 */
export function yearToDatePeriods(
  withPeriodicPay: number,
  unpaidLines: Record<string, unknown>,
  restoredPeriodicByLine: Record<string, number>,
): number {
  const restored = Object.entries(unpaidLines).filter(([id, periodic]) => Number(periodic) + (restoredPeriodicByLine[id] ?? 0) > 0);
  return withPeriodicPay + restored.length;
}

/**
 * The warnings for a run calculated while LATER periods of its tax year are
 * already approved or paid (a month back-filled, or reopened and corrected),
 * by employee: only an employee paid in those later runs, whose PAYE there was
 * calculated without this month. The cumulative method trues it up only in the
 * next period calculated after them; if February is among them, nothing does
 * (IsaFlow has no PAYE adjustment), so it stays short until the assessment.
 */
export async function laterPeriodsWarnings(
  companyId: string,
  runId: string,
  period: PayrollPeriod,
): Promise<Map<string, ValidationResult>> {
  const taxYear = getTaxYear(period.month, period.year);
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT l.employee_id, h.period_year, h.period_month
    FROM payroll_run_headers h
    JOIN payroll_run_lines l ON l.run_id = h.id
    WHERE h.company_id = ${companyId}::uuid AND h.id <> ${runId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) > make_date(${period.year}::int, ${period.month}::int, 1)
      AND make_date(h.period_year, h.period_month, 1) <= make_date(${taxYear}::int, 2, 1)
    ORDER BY l.employee_id, h.period_year, h.period_month
  `) as DbRow[];
  const months = new Map<string, string[]>();
  for (const r of rows) {
    const key = String(r.employee_id);
    const list = months.get(key) ?? [];
    list.push(`${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`);
    months.set(key, list);
  }
  // `periods` is what judgeYearToDateStale matches on; the message is for people.
  return new Map([...months].map(([employee, list]) => [employee, {
    code: 'PAYE_LATER_PERIODS_APPROVED',
    severity: 'warning' as const,
    periods: list,
    message: `Later runs of this tax year that pay this employee are already approved (${list.join(', ')}). PAYE is cumulative over `
      + 'the year, so their PAYE did not include this month: the next run calculated after them corrects it. If February is '
      + 'among them, nothing follows and IsaFlow has no PAYE adjustment: the difference stays until the employee\'s assessment, '
      + 'unless those runs are reopened and recalculated in order.',
  }]));
}
