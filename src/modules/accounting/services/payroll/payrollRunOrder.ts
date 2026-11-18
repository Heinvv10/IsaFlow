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
 * ORDERING DEPENDENCY (review #1575 M1): an off-cycle run spans its calendar month (period_start the 1st), so key 1 puts it
 * before every week of that month whatever its pay date. That is right only because off-cycle runs are monthly only:
 * payrollFrequencyGuard refuses an off-cycle run at a weekly or fortnightly frequency. Lift that and this key must change.
 * For a monthly company with one run a month it orders exactly as (period_year, period_month) did. Wave 6 FQc moved the
 * year to date, the later-periods warning, the YTD gate and the payslip year to date onto this key together (spec F2):
 * "earlier" is runIsBeforeSql (the row key below that run's), never a month comparison.
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
 * compared with a subquery of the same five columns. One sql.unsafe fragment like runOrderKeySql: an id is inlined only
 * when it is UUID-shaped (hex and dashes, so nothing else can reach the text); any other value becomes NULL, which
 * matches no run (as its ::uuid cast would refuse it).
 * When no such run exists (not this company's, or not created yet): with `ifMissing`, the runs whose period starts
 * before that month, which is exactly where a new monthly regular run of the month would sit; without it, NULL (none).
 */
export function runIsBeforeSql(alias: string, companyId: string, runId: string, ifMissing?: { year: number; month: number }) {
  const literal = (id: string) => (UUID_SHAPE.test(id) ? `'${id}'::uuid` : 'NULL::uuid');
  const ref = `FROM payroll_run_headers order_ref WHERE order_ref.id = ${literal(runId)} AND order_ref.company_id = ${literal(companyId)}`;
  const before = `(${columns(alias, 'runIsBeforeSql')}) < (SELECT ${columns('order_ref', 'runIsBeforeSql')} ${ref})`;
  if (!ifMissing) return sql.unsafe(`(${before})`);
  const year = Math.trunc(Number(ifMissing.year));
  const month = Math.trunc(Number(ifMissing.month));
  if (!Number.isFinite(year) || !Number.isFinite(month)) throw new Error('runIsBeforeSql: ifMissing is not a year and month');
  return sql.unsafe(`(CASE WHEN EXISTS (SELECT 1 ${ref}) THEN ${before} `
    + `ELSE ${alias}.period_start < make_date(${year}, ${month}, 1) END)`);
}
