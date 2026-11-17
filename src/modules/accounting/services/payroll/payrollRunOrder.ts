/**
 * Pay order (wave 6 FQb1). Until FQx, payroll_run_headers is UNIQUE (company_id, period_year, period_month), so
 * "the run of a month" and "ordered by month" named one run. With several runs a month (an off-cycle bonus beside the
 * regular run; weekly runs from FQc) a reader that means "the latest run" or "an earlier run" orders by this key.
 *
 * THE KEY'S CONTRACT, in order:
 *   1. period_start                              the period the run pays for;
 *   2. the regular run before an off-cycle run   (a bonus or termination run supplements its period's regular run,
 *                                                 and is costed on it: wave 6 OC moved this before the pay date, since
 *                                                 a regular run's run_date is NULL and so read as its period_end, after
 *                                                 any off-cycle pay date in the period);
 *   3. the pay date: run_date, else period_end   (only an off-cycle run carries run_date);
 *   4. created_at                                the run opened first comes first;
 *   5. id                                        a deterministic last resort only.
 * For a monthly company with one run a month it orders exactly as (period_year, period_month) did. The YTD gate and
 * the year-to-date figure still compare months; FQc moves both onto this key together (spec F2).
 */
import { sql } from '@/lib/neon';

const ALIAS = /^[a-z_][a-z0-9_]*$/;

const columns = (alias: string, fn: string): string => {
  if (!ALIAS.test(alias)) throw new Error(`${fn}: not an SQL alias: ${alias}`);
  return `${alias}.period_start, (${alias}.run_kind <> 'regular'), COALESCE(${alias}.run_date, ${alias}.period_end), `
    + `${alias}.created_at, ${alias}.id`;
};

/** The row value (the five keys above) of the header aliased `alias`, for ORDER BY or a row comparison. */
export function runOrderKeySql(alias: string) {
  return sql.unsafe(`(${columns(alias, 'runOrderKeySql')})`);
}
