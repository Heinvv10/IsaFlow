/**
 * What a weekly or fortnightly run refuses this wave (wave 6 FQc), judged at calculate before any write (and, for the
 * terms, where they are assigned: assertFrequencyTermsAssignable).
 *  - Fringe benefits (a vehicle or travel benefit, any 38xx component and 3701, a percent-of-RFI fund row), loans (3801)
 *    and regular-pay directives (IRP3(b)/(c), in force in the run's window) on a weekly or fortnightly employee: §0a.11
 *    (Hein 2026-11-16), support in wave 7. 400, naming the employees.
 *  - An off-cycle run at a weekly or fortnightly frequency: off-cycle runs are monthly only (coordinator ruling, review
 *    #1575 M1; OC). 400. payrollRunOrder's key relies on it: a monthly off-cycle run never sits among a month's weeks.
 *  - A run whose EMP201 month is not its pay date's month: employees' tax is declared for the month it is deducted in
 *    (Fourth Schedule para 2(1)); the run's period_year/month must be its pay date's. 409.
 *  - An employee whose tax year already has a final line at another frequency: n and F would mix two frequencies, so
 *    the frequency changes at the start of a tax year (spec §4 FQc). 409. Every frequency, monthly included: an
 *    employee moved from weekly to monthly mid-year is refused on the monthly run too.
 * Each is a PayFrequencyRefusedError, answered beside the run-kind refusal (apiRunKindUnsupported: 400 or 409 by
 * `status`, code PAY_FREQUENCY_REFUSED; MCP: payrollRefusalCodes), before any write.
 */
import { sql } from '@/lib/neon';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import type { DbRow, TxSql } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import type { RunKindReason } from './payrollRunKindGuard';
import { emp201MonthOf, payDateOf } from './payFrequencyPeriods';
import { PAYE_TAX_YEAR_START_MONTH } from '@/modules/accounting/utils/payeTaxYear';
import { getTaxYear } from './taxTables';
import type { PayFrequency, PayrollPeriod } from './payrollTypes';
import { dateColumnOf, payFrequencyOf, runPeriodOf } from './payrollFrequency';

export class PayFrequencyRefusedError extends Error {
  constructor(
    readonly status: 400 | 409, readonly reasons: RunKindReason[],
    /** PAY_PERIOD_OVERLAP: the run's dates overlap another regular run of its frequency (review #1575 G6). */
    readonly code: 'PAY_FREQUENCY_REFUSED' | 'PAY_PERIOD_OVERLAP' = 'PAY_FREQUENCY_REFUSED',
  ) {
    super(`Refused: ${reasons.map((r) => r.detail).join('; ')}.`);
    this.name = 'PayFrequencyRefusedError';
  }
}

export function isPayFrequencyRefused(err: unknown): err is PayFrequencyRefusedError {
  return err instanceof PayFrequencyRefusedError;
}

const names = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(', ') : '');

/**
 * The employees (of `employeeIds`, this company's) with terms a weekly or fortnightly run cannot cost, in the window:
 * by kind, their employee numbers.
 */
async function unsupportedTerms(companyId: string, employeeIds: string[], from: string, to: string): Promise<DbRow> {
  const rows = (await sql`
    WITH people AS (
      SELECT e.id, e.employee_number FROM payroll_employees e
       WHERE e.company_id = ${companyId}::uuid AND e.id = ANY(${employeeIds}::uuid[])
    )
    SELECT
      (SELECT array_agg(DISTINCT p.employee_number) FROM people p WHERE EXISTS (
         SELECT 1 FROM payroll_employee_fringe_benefits f
          WHERE f.company_id = ${companyId}::uuid AND f.employee_id = p.id
            AND f.effective_from <= ${to}::date AND (f.effective_to IS NULL OR f.effective_to >= ${from}::date))
         OR EXISTS (
         SELECT 1 FROM payroll_employee_components c
           JOIN payroll_components pc ON pc.id = c.component_id AND pc.company_id = ${companyId}::uuid
          WHERE c.employee_id = p.id AND c.superseded_at IS NULL
            AND c.effective_from <= ${to}::date AND (c.effective_to IS NULL OR c.effective_to >= ${from}::date)
            AND (c.percent_of_rfi IS NOT NULL OR regexp_replace(pc.sars_source_code, '\\s', '', 'g') ~ '^(38[0-9]{2}|3701)$'))
      ) AS fringe,
      (SELECT array_agg(DISTINCT p.employee_number) FROM people p JOIN payroll_loans pl
          ON pl.employee_id = p.id AND pl.company_id = ${companyId}::uuid AND pl.status = 'active') AS loans,
      (SELECT array_agg(DISTINCT p.employee_number) FROM people p JOIN tax_directives d
          ON d.employee_id = p.id AND d.company_id = ${companyId}::uuid AND d.status = 'approved'
         AND d.directive_type IN ('fixed_percentage', 'fixed_amount') AND d.effective_date <= ${to}::date
         AND (d.expiry_date IS NULL OR d.expiry_date >= ${from}::date)) AS directives
  `) as DbRow[];
  return rows[0] ?? {};
}

function termsReasons(row: DbRow, frequency: string): RunKindReason[] {
  const reasons: RunKindReason[] = [];
  const say = (what: string, v: unknown) => {
    if (names(v)) reasons.push({ clause: 'frequency_terms', detail: `employees ${names(v)} have ${what}, which a ${frequency} run cannot cost yet (support comes in a later release)` });
  };
  say('a fringe benefit (a vehicle or travel benefit, a 38xx or 3701 component, or a percent-of-RFI fund row)', row.fringe);
  say('an active loan', row.loans);
  say('a regular-pay tax directive (IRP3(b) or IRP3(c))', row.directives);
  return reasons;
}

/** What the guard reads of a run. `runKind` absent: regular. */
export interface FrequencyRun { frequency: PayFrequency; period: PayrollPeriod; runDate: string | null; runKind?: string; runId?: string }

/** A payroll_run_headers row (SELECT * shape) as the guard reads it: the one mapping calculate and its MCP dry run share. */
export function frequencyRunOf(row: Record<string, unknown>): FrequencyRun | null {
  const frequency = payFrequencyOf(row.pay_frequency);
  if (frequency === 'unsupported') return null;
  return {
    frequency, period: runPeriodOf(row), runDate: dateColumnOf(row.run_date), runKind: String(row.run_kind ?? 'regular'),
    ...(row.id == null ? {} : { runId: String(row.id) }),
  };
}

/**
 * A regular weekly or fortnightly run whose dates overlap another calculated, non-cancelled regular run of the company at
 * the same frequency would pay the overlap twice, and no run can be removed once calculated (review #1575 G6). 409. The
 * first of two overlapping runs to be calculated is costed; the other is refused.
 */
async function refuseOverlappingRun(companyId: string, run: FrequencyRun, start: string, end: string): Promise<void> {
  if ((run.runKind ?? 'regular') !== 'regular') return;
  const rows = (await sql`
    SELECT to_char(h.period_start, 'YYYY-MM-DD') AS start, to_char(h.period_end, 'YYYY-MM-DD') AS stop
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND h.pay_frequency = ${run.frequency} AND h.run_kind = 'regular'
       AND h.status <> 'cancelled' AND h.id IS DISTINCT FROM ${run.runId ?? null}::uuid
       AND daterange(h.period_start, h.period_end, '[]') && daterange(${start}::date, ${end}::date, '[]')
       -- Calculated runs only: a draft never calculated pays nobody and, with no cancel path, must not block (as G1).
       AND EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.run_id = h.id)
     ORDER BY h.period_start
  `) as DbRow[];
  if (rows.length === 0) return;
  throw new PayFrequencyRefusedError(409, [{ clause: 'pay_period_overlap', detail: `its dates ${start} to ${end} overlap the ${run.frequency} `
    + `run${rows.length > 1 ? 's' : ''} for ${rows.map((r) => `${String(r.start)} to ${String(r.stop)}`).join(', ')}: the overlap would be paid twice, `
    + 'so this run is not calculated' }], 'PAY_PERIOD_OVERLAP');
}

/** At calculate, before any write. `employeeIds`: the run's population. */
export async function assertFrequencyCostable(
  companyId: string,
  run: FrequencyRun,
  employeeIds: string[],
): Promise<void> {
  const { frequency, period } = run;
  if (frequency !== 'monthly' && run.runKind === 'off_cycle') {
    throw new PayFrequencyRefusedError(400, [{ clause: 'frequency_terms', detail: `it is an off-cycle run at a ${frequency} frequency: `
      + 'bonus and termination runs are monthly only' }]);
  }
  if (frequency !== 'monthly' && period.start && period.end) {
    await refuseOverlappingRun(companyId, run, period.start, period.end);
    const payDate = payDateOf(period, run.runDate) ?? period.end;
    const due = emp201MonthOf(payDate);
    if (due.year !== period.year || due.month !== period.month) {
      throw new PayFrequencyRefusedError(409, [{ clause: 'emp201_month', detail: `its pay date ${payDate} is not in its EMP201 month `
        + `${period.year}-${String(period.month).padStart(2, '0')}: a ${frequency} run is declared in the month it is paid (Fourth Schedule para 2(1))` }]);
    }
    const reasons = termsReasons(await unsupportedTerms(companyId, employeeIds, period.start, period.end), frequency);
    if (reasons.length > 0) throw new PayFrequencyRefusedError(400, reasons);
  }
  const taxYear = getTaxYear(period.month, period.year);
  const mixed = (await sql`
    SELECT array_agg(DISTINCT e.employee_number) AS numbers
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
     WHERE h.company_id = ${companyId}::uuid
       AND ${sql.unsafe(payRunFinalSql('h'))}
       AND h.pay_frequency <> ${frequency}
       AND make_date(h.period_year, h.period_month, 1) >= make_date(${taxYear - 1}::int, ${PAYE_TAX_YEAR_START_MONTH}::int, 1)
       AND make_date(h.period_year, h.period_month, 1) <= make_date(${taxYear}::int, 2, 1)
       AND l.employee_id = ANY(${employeeIds}::uuid[])
  `) as DbRow[];
  if (names(mixed[0]?.numbers)) {
    throw new PayFrequencyRefusedError(409, [{ clause: 'frequency_change', detail: `employees ${names(mixed[0]?.numbers)} were paid at `
      + `another frequency earlier in this tax year: change an employee's pay frequency at the start of a tax year` }]);
  }
}

/**
 * Where a weekly or fortnightly employee's terms are written (a loan, a fringe benefit, a component, a directive):
 * refused before the write when the employee is not monthly. No-op for a monthly employee.
 */
export async function assertFrequencyTermsAssignable(companyId: string, employeeId: string, what: string, db: TxSql = sql): Promise<void> {
  const rows = (await db`
    SELECT employee_number, pay_frequency FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  const e = rows[0];
  if (!e || (e.pay_frequency !== 'weekly' && e.pay_frequency !== 'fortnightly')) return;
  throw new PayFrequencyRefusedError(400, [{ clause: 'frequency_terms', detail: `employee ${String(e.employee_number)} is paid `
    + `${String(e.pay_frequency)}, and ${what} cannot be costed on a ${String(e.pay_frequency)} run yet (support comes in a later release)` }]);
}

/**
 * For the writer of payroll_employees.pay_frequency (FQd): refused (409) when the employee already has a final line
 * this tax year at another frequency. `asAt`: the date the change takes effect ('YYYY-MM-DD').
 */
export async function assertFrequencyChangeAllowed(companyId: string, employeeId: string, to: PayFrequency, asAt: string): Promise<void> {
  const month = Number(asAt.slice(5, 7));
  const year = Number(asAt.slice(0, 4));
  await assertFrequencyCostable(companyId, { frequency: to, period: { year, month }, runDate: null }, [employeeId]);
}

/** Fringe benefits (38xx) and the travel allowance (3701): costed on monthly rules only (review #1575 L1). */
const FRINGE_CODE = /^(38\d{2}|3701)$/;

/**
 * A component assignment, by any writer (assignComponentToEmployee, applyPackageToEmployee, the batch post, the pay-run
 * grid, the date edit; review #1575 M5): only a percent-of-RFI row, a 38xx or a 3701 is refused.
 */
export async function assertComponentAssignableAtFrequency(
  companyId: string, employeeId: string, componentId: string, percentOfRfi: number | null, db: TxSql = sql,
): Promise<void> {
  const rows = (await db`
    SELECT regexp_replace(sars_source_code, '\\s', '', 'g') AS code FROM payroll_components
     WHERE id = ${componentId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  const code = String(rows[0]?.code ?? '');
  if (percentOfRfi === null && !FRINGE_CODE.test(code)) return;
  await assertFrequencyTermsAssignable(companyId, employeeId, percentOfRfi !== null
    ? 'a percent-of-RFI fund contribution' : `a ${code} fringe benefit or allowance`, db);
}

/**
 * assertComponentAssignableAtFrequency for the writers that answer EmployeeComponentRefused as a 400 (the package, batch
 * and date-edit routes; the pay-run grid maps it to its own 400): the same refusal, in that class.
 */
export async function refuseComponentAtFrequency(
  db: TxSql, companyId: string, employeeId: string, componentId: string, percentOfRfi: number | null,
): Promise<void> {
  try {
    await assertComponentAssignableAtFrequency(companyId, employeeId, componentId, percentOfRfi, db);
  } catch (err) {
    if (isPayFrequencyRefused(err)) throw new EmployeeComponentRefused(err.message);
    throw err;
  }
}
