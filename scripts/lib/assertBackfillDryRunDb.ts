/**
 * Which databases the back-fill dry-run script may point at.
 *
 * DELIBERATELY NOT `tests/helpers/assertNotProductionDb.ts`, and the difference
 * is the whole reason this file exists. That guard governs ~50 test files that
 * WRITE — they create companies, post journals and delete rows — and its list
 * must stay as narrow as possible. This script writes nothing: it runs one
 * plan inside a transaction it rolls back unconditionally.
 *
 * So this list carries one name the test guard must never carry.
 * `isaflow_staging` is a `pg_dump` copy of production, restored on demand. It
 * holds production-shaped DATA, which is exactly why rehearsing the back-fill
 * against it is worth doing and exactly why a mutating test suite must not be
 * able to reach it. Two lists that differ on purpose beat one list widened
 * until it covers the loosest caller.
 *
 * ALLOW-LIST, never a deny-list. A deny-list catches only the exact production
 * name and waves through any other live database somebody points the URL at —
 * `isaflow_prod_replica` reads as fine to a rule that only knows `isaflow`.
 */

/** Production. Refused whatever else is added below. */
const PROD_DB_NAME = 'isaflow';

/**
 * Every database this script may read, by full name rather than by prefix:
 * `isaflow_prod_replica` shares eight characters with `isaflow_dev` and is not
 * a thing to point a whole-subledger row-locking read at.
 */
const ALLOWED_DB_NAMES = ['isaflow_dev', 'isaflow_test', 'isaflow_staging'];

/**
 * Throw unless DATABASE_URL names one of the three. An absent or unparseable
 * URL passes — the caller fails on it for its own reasons, with a better
 * message than this one could give.
 */
export function assertBackfillDryRunDb(reason: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, '').split('?')[0] ?? '';
  } catch {
    return;
  }
  if (name === PROD_DB_NAME || !ALLOWED_DB_NAMES.includes(name)) {
    throw new Error(
      `Refusing to run: DATABASE_URL names the database "${name}", which is not one of `
      + `${ALLOWED_DB_NAMES.join(' / ')}. ${reason} Point it at isaflow_dev.`,
    );
  }
}
