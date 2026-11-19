/**
 * Creating a weekly or fortnightly regular run (wave 6 FQd). The monthly run keeps createPayrollRun (payrollRunHeaders).
 *
 * The period comes from the company's pay week (payrollPayWeek.resolveRunPeriod; 400 RunPeriodRefused otherwise). The
 * row carries pay_frequency, run_kind 'regular', period_start / period_end, run_date = the pay date, and
 * period_year / period_month = the pay date's month (the EMP201 month; spec FQc).
 *
 * Refused before the insert, under a per-company advisory lock held to the end of the request, so two creates cannot
 * both pass the check:
 *   - the same period again: PayrollRunDuplicateError (the regular-period key of 999a also refuses it);
 *   - a period that OVERLAPS a non-cancelled regular run of the same frequency (the pay week was changed between
 *     them): PayrollRunOverlapError, since both runs would pay the overlapping days.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { PayrollRunDuplicateError, mapRunRow, type PayrollRunSummary } from './payrollRunHeaders';
import { resolveRunPeriod, type PeriodFrequency, type RunPeriod } from './payrollPayWeek';
import { readPayWeekSettings } from './payrollPayWeekSettings';
import { dateColumnOf } from './payrollFrequency';

export class PayrollRunOverlapError extends Error {
  readonly code = 'PAY_PERIOD_OVERLAP';
  constructor(f: PeriodFrequency, p: RunPeriod, other: { start: string; end: string }) {
    super(`The ${f} period ${p.periodStart} to ${p.periodEnd} overlaps the run for ${other.start} to ${other.end}; both would pay the same days.`);
    this.name = 'PayrollRunOverlapError';
  }
}

/** The refusal a create of `period` would meet now (duplicate or overlap), or null. Read-only. */
async function periodClash(db: TxSql, companyId: string, frequency: PeriodFrequency, period: RunPeriod): Promise<Error | null> {
  const clash = (await db`
    SELECT period_start, period_end FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid AND pay_frequency = ${frequency} AND run_kind = 'regular' AND status <> 'cancelled'
       AND period_start <= ${period.periodEnd}::date AND period_end >= ${period.periodStart}::date
     ORDER BY period_start LIMIT 1
  `) as DbRow[];
  const other = clash[0];
  if (!other) return null;
  const start = dateColumnOf(other.period_start) ?? '';
  const end = dateColumnOf(other.period_end) ?? '';
  return start === period.periodStart
    ? new PayrollRunDuplicateError(period.periodMonth, period.periodYear, `A ${frequency} payroll run for ${start} already exists.`)
    : new PayrollRunOverlapError(frequency, period, { start, end });
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
  const period = resolveRunPeriod(frequency, periodStart, await readPayWeekSettings(companyId));
  log.info('Creating payroll run', { companyId, frequency, periodStart: period.periodStart }, 'payrollRunCreatePeriod');
  return withTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll_run_create:${companyId}`}, 0))`;
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
