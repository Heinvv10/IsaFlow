/**
 * Wave 7 EL (W25, Hein ruling 3 of 2026-11-25): a REGULAR run whose month's EMP201 is filed is not reopened. The
 * declaration SARS holds counts the run as approved; reopening it would change payroll's figures under a filed return.
 * The refusal (409 EMP201_FILED) names the EMP201's reference. Corrections go through an off-cycle run in a month whose
 * EMP201 is not filed. "Filed" is emp201FiledForMonth's test, the one the off-cycle reopen uses (payrollOffCycleGates):
 * a filed or finalised version, or a legacy submitted or accepted submission. A finalised version not filed yet blocks
 * too (amend it, then reopen): filing it would be refused on the drift anyway.
 *
 * Which month: the run's EMP201 month as payroll declares it (period_year / period_month, emp201Service) AND the month
 * of its pay date (Fourth Schedule para 2(1): employees' tax is declared for the month it is paid; payDateOf, the
 * run's run_date else its period's last day). A weekly or fortnightly run's two agree (payrollFrequencyGuard refuses
 * costing one paid outside its period month); a monthly run paid early the next month is judged on both.
 *
 * Lock order (census in the EL PR): judged by reopenPayrollRun under the payroll approval lock and the header lock,
 * as a plain read before any write. A filing takes the approval lock before its drift check, so a filing in flight
 * either committed before this read (refused here) or reads the reopened run after this commit (its drift check sees
 * a run that is not final and refuses).
 */
import type { DbRow } from '@/lib/neon';
import { dateColumnOf } from './payrollFrequency';
import { emp201MonthOf, payDateOf } from './payFrequencyPeriods';
import { emp201FilingFor, emp201FilingText } from './payrollOffCycleCorrection';

/** 409 EMP201_FILED, raised before any write; the route answers it as a conflict with its code. */
export class Emp201FiledReopenError extends Error {
  readonly code = 'EMP201_FILED';
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'Emp201FiledReopenError';
  }
}

const label = (m: { year: number; month: number }) => `${m.year}-${String(m.month).padStart(2, '0')}`;

/** The months a regular run declares in: its period month, and its pay date's month when that differs. */
export function regularRunEmp201Months(run: DbRow): { year: number; month: number }[] {
  const period = { year: Number(run.period_year), month: Number(run.period_month) };
  const payDate = payDateOf({ end: dateColumnOf(run.period_end) ?? undefined }, dateColumnOf(run.run_date));
  const paid = payDate === null ? null : emp201MonthOf(payDate);
  return paid && (paid.year !== period.year || paid.month !== period.month) ? [period, paid] : [period];
}

/** Why this regular run is not reopened (its month's EMP201 is filed), naming the EMP201; null when it may be. */
export async function regularReopenFiledRefusal(companyId: string, run: DbRow): Promise<string | null> {
  if (run.run_kind === 'off_cycle') return null; // judged by offCyclePaidReopenRefusal
  for (const m of regularRunEmp201Months(run)) {
    const filing = await emp201FilingFor(companyId, m.year, m.month);
    if (!filing) continue;
    const next = filing.source === 'finalised_version'
      ? `Amend that EMP201 version first, then reopen this run.`
      : 'The filed declaration stands: make the correction on an off-cycle run in a month whose EMP201 is not filed.';
    return `This pay run is not reopened: the EMP201 for ${label(m)} ${emp201FilingText(filing)}. ${next}`;
  }
  return null;
}
