/**
 * Creating an off-cycle run (wave 6 OC, spec §4 OC): a bonus or termination run that supplements a month's FINAL
 * regular monthly run, for a chosen set of that company's monthly employees, paid on `runDate`.
 *
 *  - bonus        each employee is paid one annual-payment earning (one of the company's 3605 components) and nothing
 *                 else, taxed as an annual payment on the month's annual equivalent (payeCumulative: tax(AE + A) -
 *                 tax(AE), PAYE-GEN-01-G21 (2027) pp. 32-33). The employee must have a line on that regular run.
 *  - termination  each employee left in the month (end_date in it) after the regular run, with a termination reason
 *                 captured, and their leave/notice pay-outs not paid yet; the line pays those (and severance, only
 *                 under an approved directive) through payrollRunTermination, as a final run would.
 *
 * The pay date is in the run's month (the EMP201 month of the run, Fourth Schedule para 2(1)) and not before today in
 * South Africa; approval refuses it again if it has passed by then (payrollOffCycleApproval). Every refusal is judged
 * before the first write (spec rule 12); the inputs go to payroll_off_cycle_employees (migration 999x), never to
 * payroll_employee_components (the regular run would pay a once-off dated in its month).
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { todayInSast } from '@/lib/saDateParser';
import { payRunFinalSql } from './payRunFinalSql';
import { mapRunRow, type PayrollRunSummary } from './payrollRunHeaders';
import { findPaidTerminationRun } from './payrollTerminationPaidCheck';
import type { OffCycleReason, PayrollPeriod } from './payrollTypesRun';

export interface OffCycleEmployeeInput { employeeId: string; componentId?: string | null; amount?: number | null }

export interface OffCycleRunInput {
  period: PayrollPeriod;
  reason: OffCycleReason;
  /** The pay date, 'YYYY-MM-DD'. */
  runDate: string;
  employees: OffCycleEmployeeInput[];
}

/** Refused before any write: 400 for a malformed request, 409 for one the company's state does not allow. */
export class OffCycleRunRefusedError extends Error {
  readonly code = 'OFF_CYCLE_RUN_REFUSED';
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
    this.name = 'OffCycleRunRefusedError';
  }
}

const MONTH_UNIQUE = 'payroll_run_headers_company_id_period_year_period_month_key';
const NO_RUN = '00000000-0000-0000-0000-000000000000';
const MAX_EMPLOYEES = 1000;
const MAX_BONUS = 100_000_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (m: string) => new OffCycleRunRefusedError(m, 400);
const state = (m: string) => new OffCycleRunRefusedError(m, 409);
const monthName = (p: PayrollPeriod) => `${p.year}-${String(p.month).padStart(2, '0')}`;

/** The request's shape alone (no reads). Exported for the unit tests. */
export function judgeOffCycleShape(input: OffCycleRunInput, today: string): void {
  const { period, reason, runDate, employees } = input;
  if (reason !== 'bonus' && reason !== 'termination') throw bad('reason must be bonus or termination');
  if (typeof runDate !== 'string' || !ISO_DAY.test(runDate) || Number.isNaN(Date.parse(`${runDate}T00:00:00Z`))
    || new Date(`${runDate}T00:00:00Z`).toISOString().slice(0, 10) !== runDate) throw bad('runDate must be a date, YYYY-MM-DD');
  if (runDate.slice(0, 7) !== monthName(period)) throw bad(`the pay date must be in ${monthName(period)}, the run's month`);
  if (runDate < today) throw bad(`the pay date ${runDate} has passed: an off-cycle run is paid today or later`);
  if (!Array.isArray(employees) || employees.length === 0) throw bad('choose at least one employee');
  if (employees.length > MAX_EMPLOYEES) throw bad(`at most ${MAX_EMPLOYEES} employees in one run`);
  const seen = new Set<string>();
  for (const e of employees) {
    if (typeof e?.employeeId !== 'string' || !UUID.test(e.employeeId)) throw bad('each employee needs an employeeId');
    if (seen.has(e.employeeId)) throw bad('an employee is listed twice');
    seen.add(e.employeeId);
    if (reason === 'termination') {
      if (e.componentId != null || e.amount != null) throw bad('a termination run takes no amounts: it pays the termination pay-outs');
      continue;
    }
    if (typeof e.componentId !== 'string' || !UUID.test(e.componentId)) throw bad('each bonus needs its annual-payment component');
    const a = e.amount;
    if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0 || a > MAX_BONUS || Math.round(a * 100) !== a * 100) {
      throw bad('each bonus amount must be more than nil, in rand and cents');
    }
  }
}

/** Every refusal the company's state decides, before any write. */
async function judgeOffCycleState(tx: TxSql, companyId: string, input: OffCycleRunInput): Promise<void> {
  const { period, reason, employees } = input;
  const regular = (await tx`
    SELECT h.id FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND h.period_year = ${period.year} AND h.period_month = ${period.month}
       AND h.run_kind = 'regular' AND h.pay_frequency = 'monthly' AND ${sql.unsafe(payRunFinalSql('h'))}
     FOR SHARE OF h
  `) as DbRow[];
  if (!regular[0]) throw state(`${monthName(period)} has no approved regular run: approve it before an off-cycle run`);
  const regularId = String(regular[0].id);
  const ids = employees.map((e) => e.employeeId);
  const people = (await tx`
    SELECT e.id, e.employee_number, e.pay_frequency, e.end_date::text AS end_date,
           EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.run_id = ${regularId}::uuid AND l.employee_id = e.id) AS on_regular,
           EXISTS (SELECT 1 FROM payroll_off_cycle_employees x JOIN payroll_run_headers o ON o.id = x.run_id
                    WHERE x.employee_id = e.id AND x.company_id = e.company_id AND o.company_id = e.company_id
                      AND o.period_year = ${period.year} AND o.period_month = ${period.month}
                      AND o.status IN ('draft', 'calculated')) AS on_open_off_cycle
      FROM payroll_employees e
     WHERE e.company_id = ${companyId}::uuid AND e.id = ANY(${ids}::uuid[])
  `) as DbRow[];
  const byId = new Map(people.map((p) => [String(p.id), p]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw bad(`${missing.length} of the chosen employees are not this company's`);
  const named = (pred: (p: DbRow) => boolean) => people.filter(pred).map((p) => String(p.employee_number)).sort().join(', ');
  const notMonthly = named((p) => p.pay_frequency !== 'monthly');
  if (notMonthly) throw state(`employees ${notMonthly} are not paid monthly: off-cycle runs are for monthly employees`);
  const open = named((p) => p.on_open_off_cycle === true);
  if (open) throw state(`employees ${open} are already on an off-cycle run of ${monthName(period)} that is not approved`);
  if (reason === 'bonus') {
    const off = named((p) => p.on_regular !== true);
    if (off) throw state(`employees ${off} have no line on the ${monthName(period)} regular run`);
    const componentIds = [...new Set(employees.map((e) => String(e.componentId)))];
    const ok = (await tx`
      SELECT id FROM payroll_components
       WHERE company_id = ${companyId}::uuid AND id = ANY(${componentIds}::uuid[])
         AND component_type = 'earning' AND btrim(sars_source_code) = '3605'
    `) as DbRow[];
    if (ok.length !== componentIds.length) throw bad('a bonus must be paid on one of the company\'s annual-payment earnings (SARS code 3605)');
    return;
  }
  const notLeaving = named((p) => typeof p.end_date !== 'string' || String(p.end_date).slice(0, 7) !== monthName(period));
  if (notLeaving) throw state(`employees ${notLeaving} have no end date in ${monthName(period)}: record the termination first`);
  for (const p of people) {
    // Any final run that paid them (the regular run included): none is excluded, the off-cycle run does not exist yet.
    const paid = await findPaidTerminationRun(companyId, String(p.id), NO_RUN);
    if (paid) throw state(`employee ${String(p.employee_number)}'s termination pay-outs were already paid in the ${paid.year}-${String(paid.month).padStart(2, '0')} run`);
  }
}

export async function createOffCycleRun(companyId: string, input: OffCycleRunInput, createdBy: string | null): Promise<PayrollRunSummary> {
  judgeOffCycleShape(input, todayInSast());
  const { period, reason, runDate, employees } = input;
  try {
    return await withTransaction(async (tx) => {
      await judgeOffCycleState(tx, companyId, input);
      const rows = (await tx`
        INSERT INTO payroll_run_headers (
          company_id, period_month, period_year, created_by, pay_frequency, run_kind, off_cycle_reason, period_start, period_end, run_date
        ) VALUES (
          ${companyId}::uuid, ${period.month}, ${period.year}, ${createdBy}, 'monthly', 'off_cycle', ${reason},
          public.payroll_month_period_start(${period.year}::int, ${period.month}::int),
          public.payroll_month_period_end(${period.year}::int, ${period.month}::int), ${runDate}::date
        ) RETURNING *
      `) as DbRow[];
      const run = rows[0];
      if (!run) throw new Error('INSERT returned no row');
      for (const e of employees) {
        await tx`
          INSERT INTO payroll_off_cycle_employees (company_id, run_id, employee_id, component_id, amount, created_by)
          VALUES (${companyId}::uuid, ${String(run.id)}::uuid, ${e.employeeId}::uuid, ${e.componentId ?? null}::uuid, ${e.amount ?? null}, ${createdBy})
        `;
      }
      log.info('Off-cycle payroll run created', { companyId, runId: String(run.id), reason, employees: employees.length }, 'payrollOffCycleRun');
      return mapRunRow(run);
    });
  } catch (err) {
    // Until FQx drops the per-month unique, a month holding its regular run cannot hold another run (a 409, nothing written).
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === MONTH_UNIQUE) {
      throw state(`${monthName(period)} already has a run, and this database allows one run a month until the per-month limit is lifted`);
    }
    throw err;
  }
}
