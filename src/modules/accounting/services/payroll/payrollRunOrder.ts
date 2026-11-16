/**
 * Pay order (wave 6 FQb1). Until FQx, payroll_run_headers is UNIQUE (company_id, period_year, period_month), so
 * "the run of a month" and "ordered by month" named one run. With several runs a month (an off-cycle bonus beside the
 * regular run; weekly runs from FQc) a reader that means "the latest run" or "an earlier run" orders by this key:
 *
 *   (period_start, the pay date (run_date, else period_end), id)
 *
 * id only breaks a tie deterministically. For a monthly company with one run a month the key orders exactly as
 * (period_year, period_month) did. FQc's year-to-date bound (spec F2) uses the same key, so the gate and the figure agree.
 */
import { sql } from '@/lib/neon';

const ALIAS = /^[a-z_][a-z0-9_]*$/;

const columns = (alias: string, fn: string): string => {
  if (!ALIAS.test(alias)) throw new Error(`${fn}: not an SQL alias: ${alias}`);
  return `${alias}.period_start, COALESCE(${alias}.run_date, ${alias}.period_end), ${alias}.id`;
};

/** The row value `(period_start, pay date, id)` of the header aliased `alias`, for ORDER BY or a row comparison. */
export function runOrderKeySql(alias: string) {
  return sql.unsafe(`(${columns(alias, 'runOrderKeySql')})`);
}

/** The same three as a select list, for a scalar subquery compared with runOrderKeySql: `key < (SELECT …)`. */
export function runOrderColumnsSql(alias: string) {
  return sql.unsafe(columns(alias, 'runOrderColumnsSql'));
}
