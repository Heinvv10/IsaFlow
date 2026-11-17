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
import { withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
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

/** The period a create would open, judged without writing (for the MCP dry run). Throws RunPeriodRefused. */
export async function previewPeriodRun(companyId: string, frequency: PeriodFrequency, periodStart: unknown): Promise<RunPeriod> {
  return resolveRunPeriod(frequency, periodStart, await readPayWeekSettings(companyId));
}

export async function createPeriodRun(
  companyId: string, frequency: PeriodFrequency, periodStart: unknown, createdBy?: string,
): Promise<PayrollRunSummary> {
  const period = await previewPeriodRun(companyId, frequency, periodStart);
  log.info('Creating payroll run', { companyId, frequency, periodStart: period.periodStart }, 'payrollRunCreatePeriod');
  return withTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll_run_create:${companyId}`}, 0))`;
    const clash = (await tx`
      SELECT period_start, period_end FROM payroll_run_headers
       WHERE company_id = ${companyId}::uuid AND pay_frequency = ${frequency} AND run_kind = 'regular' AND status <> 'cancelled'
         AND period_start <= ${period.periodEnd}::date AND period_end >= ${period.periodStart}::date
       ORDER BY period_start LIMIT 1
    `) as DbRow[];
    const other = clash[0];
    if (other) {
      const start = dateColumnOf(other.period_start) ?? '';
      const end = dateColumnOf(other.period_end) ?? '';
      if (start === period.periodStart) throw new PayrollRunDuplicateError(period.periodMonth, period.periodYear, `A ${frequency} payroll run for ${start} already exists.`);
      throw new PayrollRunOverlapError(frequency, period, { start, end });
    }
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
