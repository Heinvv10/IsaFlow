/**
 * Reading the pay-frequency and run-kind columns (migration 999a) off a row. A value outside the known set reads as
 * 'unsupported', never as a known value: the row still lists (a throw here would fail the whole list on a colour
 * rolled back past a CHECK widening, review #1483), and payrollRunKindGuard refuses to act on it.
 * An ABSENT key (undefined) reads as the column default: only a hand-built row lacks it, since every
 * SELECT * of the two tables carries the columns from 999a on.
 */
import { PAY_FREQUENCIES, type OffCycleReason, type PayFrequency, type PayrollPeriod, type RunKind, type UnsupportedValue } from './payrollTypesRun';

export function payFrequencyOf(raw: unknown): PayFrequency | UnsupportedValue {
  if (raw === undefined) return 'monthly';
  return PAY_FREQUENCIES.find((f) => f === raw) ?? 'unsupported';
}

export function runKindOf(raw: unknown): RunKind | UnsupportedValue {
  if (raw === undefined || raw === 'regular') return 'regular';
  return raw === 'off_cycle' ? 'off_cycle' : 'unsupported';
}

export function offCycleReasonOf(raw: unknown): OffCycleReason | UnsupportedValue | null {
  if (raw === undefined || raw === null) return null;
  return raw === 'bonus' || raw === 'termination' ? raw : 'unsupported';
}

/** A DATE column as 'YYYY-MM-DD' (pgTypes parses DATE to that string; a Date from a hand-built row reads by its local day). */
export function dateColumnOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (raw instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${raw.getFullYear()}-${p(raw.getMonth() + 1)}-${p(raw.getDate())}`;
  }
  return String(raw).slice(0, 10);
}

/**
 * A run row's period as the engine reads it (wave 6 FQc): the EMP201 month, plus the run's own dates when it is not a
 * monthly run. A monthly run carries no dates, so every reader keyed by them (payrollRunReadDate, the once-off window,
 * the pro-rata band, the run population) reads it exactly as the calendar month, as before.
 */
export function runPeriodOf(row: Record<string, unknown>): PayrollPeriod {
  const period: PayrollPeriod = { year: Number(row.period_year), month: Number(row.period_month) };
  if (payFrequencyOf(row.pay_frequency) === 'monthly') return period;
  const start = dateColumnOf(row.period_start);
  const end = dateColumnOf(row.period_end);
  return start && end ? { ...period, start, end } : period;
}
