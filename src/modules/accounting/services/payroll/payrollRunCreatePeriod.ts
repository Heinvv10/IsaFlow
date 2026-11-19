/**
 * Creating a weekly or fortnightly regular run (wave 6 FQd). The monthly run keeps createPayrollRun (payrollRunHeaders).
 *
 * The period comes from the company's pay week (payrollPayWeek.resolveRunPeriod; 400 RunPeriodRefused otherwise). The
 * row carries pay_frequency, run_kind 'regular', period_start / period_end, run_date = the pay date, and
 * period_year / period_month = the pay date's month (the EMP201 month; spec FQc).
 *
 * Refused before the insert, under the company's payroll-approval lock (the one the pay-week PUT takes) held to the end
 * of the request, with the pay week read under it: two creates cannot both pass the check, and the pay week cannot
 * change between the read and the insert:
 *   - the same period again: PayrollRunDuplicateError (the regular-period key of 999a also refuses it);
 *   - a period that OVERLAPS a non-cancelled regular run of the same frequency (the pay week was changed between
 *     them): PayrollRunOverlapError, since both runs would pay the overlapping days;
 *   - a period starting before an approved run that holds an acknowledged pay-frequency change for an employee paid at
 *     this frequency now (breaker #1622 M-F): PayrollRunOverlapError naming that run, since its once-off settled them.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { PayrollRunDuplicateError, mapRunRow, type PayrollRunSummary } from './payrollRunHeaders';
import { formatDayRange, resolveRunPeriod, type PeriodFrequency, type RunPeriod } from './payrollPayWeek';
import { readPayWeekSettings } from './payrollPayWeekSettings';
import { dateColumnOf } from './payrollFrequency';
import { lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
import { acknowledgedLater, acknowledgedLaterDetail, straddleAcks } from './payrollFrequencyAcks';

export class PayrollRunOverlapError extends Error {
  readonly code = 'PAY_PERIOD_OVERLAP';
  constructor(f: PeriodFrequency, p: RunPeriod, other: { start: string; end: string }, message?: string) {
    super(message ?? `The ${f} period ${p.periodStart} to ${p.periodEnd} overlaps the run for ${other.start} to ${other.end}; both would pay the same days.`);
    this.name = 'PayrollRunOverlapError';
  }
}

/** The refusal a create of `period` would meet now (duplicate or overlap), or null. Read-only. */
async function periodClash(db: TxSql, companyId: string, frequency: PeriodFrequency, period: RunPeriod): Promise<Error | null> {
  const clash = (await db`
    SELECT id, period_start, period_end FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid AND pay_frequency = ${frequency} AND run_kind = 'regular' AND status <> 'cancelled'
       AND period_start <= ${period.periodEnd}::date AND period_end >= ${period.periodStart}::date
     ORDER BY period_start LIMIT 1
  `) as DbRow[];
  const other = clash[0];
  if (!other) {
    // An approved run at this frequency holding an acknowledged pay-frequency change for an employee paid at it now:
    // a run starting before it would pay the days its once-off settled (breaker #1622 M-F (1)).
    const later = acknowledgedLater(await straddleAcks(db, companyId, frequency, null), period.periodStart, period.periodEnd);
    return later ? new PayrollRunOverlapError(frequency, period, { start: later.runStart, end: later.runEnd },
      acknowledgedLaterDetail(later, frequency, period.periodStart)) : null;
  }
  const start = dateColumnOf(other.period_start) ?? '';
  const end = dateColumnOf(other.period_end) ?? '';
  if (start !== period.periodStart) return new PayrollRunOverlapError(frequency, period, { start, end });
  // The period in plain words, and the run to open instead (review #1622 UI L3).
  const label = `${frequency === 'weekly' ? 'Week' : 'Fortnight'} ${formatDayRange(start, end)}`;
  return new PayrollRunDuplicateError(period.periodMonth, period.periodYear, `The run for ${label} already exists.`, String(other.id));
}

/**
 * What a create would do, judged without writing (the MCP dry run runs every check the live call runs): the period,
 * or RunPeriodRefused; `refusal` is the duplicate or overlap the live call would meet now.
 */
export async function previewPeriodRun(
  companyId: string, frequency: PeriodFrequency, periodStart: unknown,
): Promise<{ period: RunPeriod; refusal: Error | null }> {
  const period = resolveRunPeriod(frequency, periodStart, await readPayWeekSettings(companyId));
  return { period, refusal: await periodClash(sql, companyId, frequency, period) };
}

export async function createPeriodRun(
  companyId: string, frequency: PeriodFrequency, periodStart: unknown, createdBy?: string,
): Promise<PayrollRunSummary> {
  log.info('Creating payroll run', { companyId, frequency }, 'payrollRunCreatePeriod');
  return withTransaction(async (tx) => {
    // The lock the pay-week PUT takes (setPayWeekSettings): the settings read below cannot change before the insert,
    // and two creates are serialised too (review #1622 L1).
    await lockCompanyPayrollForComponentChange(tx, companyId);
    const period = resolveRunPeriod(frequency, periodStart, await readPayWeekSettings(companyId, tx));
    const refusal = await periodClash(tx, companyId, frequency, period);
    if (refusal) throw refusal;
    const rows = (await tx`
      INSERT INTO payroll_run_headers (
        company_id, period_month, period_year, created_by, pay_frequency, run_kind, period_start, period_end, run_date
      ) VALUES (
        ${companyId}::uuid, ${period.periodMonth}, ${period.periodYear}, ${createdBy ?? null}, ${frequency}, 'regular',
        ${period.periodStart}::date, ${period.periodEnd}::date, ${period.payDate}::date
      )
      RETURNING *
    `) as DbRow[];
    if (!rows[0]) throw new Error('INSERT returned no row');
    return mapRunRow(rows[0]);
  });
}
