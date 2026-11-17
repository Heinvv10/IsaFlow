/**
 * Pay order (wave 6 FQb1). Until FQx, payroll_run_headers is UNIQUE (company_id, period_year, period_month), so
 * "the run of a month" and "ordered by month" named one run. With several runs a month (an off-cycle bonus beside the
 * regular run; weekly runs from FQc) a reader that means "the latest run" or "an earlier run" orders by this key.
 *
 * THE KEY'S CONTRACT, in order:
 *   1. period_start                              the period the run pays for;
 *   2. the pay date: run_date, else period_end   (no app code writes run_date today, so in practice period_end);
 *   3. the regular run before an off-cycle run   (a bonus or termination run supplements its period's regular run);
 *   4. created_at                                the run opened first comes first;
 *   5. id                                        a deterministic last resort only.
 * For a monthly company with one run a month it orders exactly as (period_year, period_month) did. Wave 6 FQc moved the
 * year to date, the later-periods warning, the YTD gate and the payslip year to date onto this key together (spec F2):
 * "earlier" is `runOrderKeySql('h') < runOrderKeyOfSql(...)`, never a month comparison.
 */
import { sql } from '@/lib/neon';

const ALIAS = /^[a-z_][a-z0-9_]*$/;

const columns = (alias: string, fn: string): string => {
  if (!ALIAS.test(alias)) throw new Error(`${fn}: not an SQL alias: ${alias}`);
  return `${alias}.period_start, COALESCE(${alias}.run_date, ${alias}.period_end), (${alias}.run_kind <> 'regular'), `
    + `${alias}.created_at, ${alias}.id`;
};

/** The row value (the five keys above) of the header aliased `alias`, for ORDER BY or a row comparison. */
export function runOrderKeySql(alias: string) {
  return sql.unsafe(`(${columns(alias, 'runOrderKeySql')})`);
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `<alias's key> < the key of run `runId` (this company's)`: the runs before it in pay order (wave 6 FQc). A row
 * compared with a subquery of the same five columns; NULL (no row matches) when the run is not this company's.
 * One sql.unsafe fragment like runOrderKeySql: an id is inlined only when it is UUID-shaped (hex and dashes, so nothing
 * else can reach the text); any other value becomes NULL, which matches no run (as its ::uuid cast would refuse it).
 */
export function runIsBeforeSql(alias: string, companyId: string, runId: string) {
  const literal = (id: string) => (UUID_SHAPE.test(id) ? `'${id}'::uuid` : 'NULL::uuid');
  return sql.unsafe(`(${columns(alias, 'runIsBeforeSql')}) < (SELECT ${columns('order_ref', 'runIsBeforeSql')} `
    + `FROM payroll_run_headers order_ref WHERE order_ref.id = ${literal(runId)} AND order_ref.company_id = ${literal(companyId)})`);
}
