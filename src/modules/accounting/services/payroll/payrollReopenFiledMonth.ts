/**
 * Wave 7 EL (W25, Hein ruling 3 of 2026-11-25): a REGULAR run whose month's EMP201 is filed is not reopened. The
 * declaration SARS holds counts the run as approved; reopening it would change payroll's figures under a filed return.
 * The refusal (409 EMP201_FILED) names the EMP201's reference. Corrections go through an off-cycle run in a month whose
 * EMP201 is not filed. "Filed" is emp201FilingFor's test, the one the off-cycle reopen uses (payrollOffCycleGates): a
 * version once filed (amended since included), a finalised version, or a legacy submitted or accepted submission. A
 * finalised version not filed yet refuses too (amend it, then reopen).
 *
 * Which month: the run's period month (period_year / period_month), the month emp201Service declares it in and that
 * finalise and the drift check attribute it to. Weekly and fortnightly runs are paid in their period month
 * (payrollFrequencyGuard). Statutory pay-date attribution of a monthly run paid in the next month is logged for wave 8.
 *
 * Races (census in the EL PR): judged by reopenPayrollRun under the payroll approval lock and its header FOR UPDATE, a
 * plain read before any write. A finalise share-locks the period's run headers (FOR SHARE, finaliseEmpReturn), so a
 * finalise and a reopen of the same month serialise on the header: a finalise first commits its version before this
 * read (refused here); a reopen first makes the finalise see a run that is not final (refused there). A filing needs a
 * finalised version, which already refuses the reopen.
 */
import type { DbRow } from '@/lib/neon';
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

/** Why this regular run is not reopened (its month's EMP201 is filed), naming the EMP201; null when it may be. */
export async function regularReopenFiledRefusal(companyId: string, run: DbRow): Promise<string | null> {
  if (run.run_kind === 'off_cycle') return null; // judged by offCyclePaidReopenRefusal
  const m = { year: Number(run.period_year), month: Number(run.period_month) };
  const filing = await emp201FilingFor(companyId, m.year, m.month);
  if (!filing) return null;
  const next = filing.source === 'finalised_version'
    ? 'Amend that EMP201 version first, then reopen this run.'
    : 'The filed declaration stands: make the correction on an off-cycle run in a month whose EMP201 is not filed.';
  return `This pay run is not reopened: the EMP201 for ${label(m)} ${emp201FilingText(filing)}. ${next}`;
}
