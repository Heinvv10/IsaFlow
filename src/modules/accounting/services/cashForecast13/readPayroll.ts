/**
 * Payroll for the forecast (ruling 2026-11-16; review L3). Only REGULAR MONTHLY runs (`run_kind = 'regular'`,
 * `pay_frequency = 'monthly'`, migration 999a) with status approved or paid count; a weekly or fortnightly
 * regular run is warned `payroll_frequency_unsupported`, never guessed as monthly.
 *   - Each pay date (the pay day of a month, back to Friday) from today to the horizon end pays that month's
 *     own run net when the month has an approved run, else the latest run's `total_net`. A paid month is not paid again.
 *   - A pay date BEFORE today is assumed paid, as a past SARS due date is (H1): nothing in the app sets a run
 *     to 'paid', so "approved and past its pay date" is how every paid run looks. The recent ones (pay date in
 *     the 45 days to today) are listed in `payroll_past_assumed_paid` so an unpaid one can be seen.
 * No run → no line (the service warns).
 * Off-cycle runs (wave 6 OC: a bonus or termination run beside a month's regular run) are paid on their own pay date
 * (`run_date`, which approval refuses to be in the past), once, on top of the month's regular net pay: never as the
 * month's run, never repeated. One whose pay date has passed is assumed paid, and listed as the regular ones are.
 */
import { formatCents } from '@/lib/money/formatMoney';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import { payDateOf, payDatesInHorizon, type PayDay } from './payDates';
import { toCents } from './lines';
import { addDays } from './weeks';
import type { ForecastWarning, KnownItem } from './types';

export interface MonthlyRun {
  id: string;
  /** 'YYYY-MM'. */
  period: string;
  status: string;
  netCents: number;
  /** PAYE net of ETI (never below 0) + UIF + SDL: what that run's EMP201 remits, for a month not yet run. */
  statutoryCents: number;
}

export interface OffCycleRun extends MonthlyRun {
  /** 'bonus' | 'termination'. */
  reason: string;
  /** The pay date, 'YYYY-MM-DD'. */
  runDate: string;
}

export interface PayrollRead {
  /** The latest regular monthly run, or null. */
  latest: MonthlyRun | null;
  runs: MonthlyRun[];
  /** Final off-cycle monthly runs (OC); absent = none. */
  offCycle?: OffCycleRun[];
  /** A regular approved/paid run that is weekly or fortnightly exists. */
  unsupportedFrequency: boolean;
}

export const RECENT_PAST_DAYS = 45;

export function toMonthlyRun(r: DbRow): MonthlyRun {
  return {
    id: String(r.id),
    period: `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`,
    status: String(r.status),
    netCents: toCents(String(r.total_net)),
    statutoryCents: Math.max(0, toCents(String(r.total_paye)) - toCents(String(r.total_eti)))
      + toCents(String(r.total_uif)) + toCents(String(r.total_sdl)),
  };
}

export async function readPayroll(companyId: string): Promise<PayrollRead> {
  const rows = (await sql`
    SELECT id, period_year, period_month, status, pay_frequency, run_kind, off_cycle_reason, run_date::text AS run_date,
           total_net, total_paye, total_eti, total_uif, total_sdl
    FROM payroll_run_headers
    -- FINAL runs only (payRunFinalSql, wave 6 EF): the runs the EMP201 declares.
    WHERE company_id = ${companyId}::UUID AND ${sql.unsafe(payRunFinalSql('payroll_run_headers'))}
    ORDER BY period_year DESC, period_month DESC, id
  `) as DbRow[];
  const regular = rows.filter((r) => r.run_kind === 'regular');
  const runs = regular.filter((r) => r.pay_frequency === 'monthly').map(toMonthlyRun);
  const offCycle = rows.filter((r) => r.run_kind === 'off_cycle' && r.pay_frequency === 'monthly' && r.run_date != null)
    .map((r) => ({ ...toMonthlyRun(r), reason: String(r.off_cycle_reason), runDate: String(r.run_date).slice(0, 10) }));
  return { latest: runs[0] ?? null, runs, offCycle, unsupportedFrequency: regular.some((r) => r.pay_frequency !== 'monthly') };
}

export function payrollItems(read: PayrollRead, payDay: PayDay, today: string, horizonEnd: string, warnings: ForecastWarning[]): KnownItem[] {
  const latest = read.latest;
  if (!latest) return [];
  const byPeriod = new Map(read.runs.map((r) => [r.period, r]));
  const paidMonths = new Set(read.runs.filter((r) => r.status === 'paid').map((r) => r.period));
  const offCycle = (read.offCycle ?? []).filter((r) => r.status !== 'paid');
  const recent = [
    ...read.runs.filter((r) => r.status !== 'paid').map((r) => ({ r, date: payDateOf(payDay, r.period), what: r.period })),
    ...offCycle.map((r) => ({ r, date: r.runDate, what: `${r.period} ${r.reason}` })),
  ].filter(({ date }) => date < today && date >= addDays(today, -RECENT_PAST_DAYS));
  if (recent.length > 0) {
    warnings.push({
      code: 'payroll_past_assumed_paid', source: 'payroll',
      message: `Net pay assumed paid (pay date before today, in opening cash): ${recent.map(({ r, date, what }) => `${what} on ${date} ${formatCents(r.netCents)}`).join('; ')}`,
    });
  }
  const items: KnownItem[] = [];
  for (const date of payDatesInHorizon(payDay, today, horizonEnd, paidMonths)) {
    const own = byPeriod.get(date.slice(0, 7));
    const run = own ?? latest;
    if (run.netCents <= 0) continue;
    items.push({
      lineKey: 'payroll:net', lineLabel: 'Salaries and wages (net pay)', category: 'payroll', date, amountCents: -run.netCents,
      ref: `${run.id}:${date}`, refLabel: own ? `Net pay of the ${run.period} run` : `Net pay as the ${run.period} run`,
    });
  }
  for (const r of offCycle) {
    if (r.runDate < today || r.runDate > horizonEnd || r.netCents <= 0) continue;
    items.push({
      lineKey: 'payroll:net', lineLabel: 'Salaries and wages (net pay)', category: 'payroll', date: r.runDate, amountCents: -r.netCents,
      ref: `${r.id}:${r.runDate}`, refLabel: `Net pay of the ${r.period} ${r.reason} run`,
    });
  }
  return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
