/**
 * Guard for tests that write to (or delete from) a real database.
 *
 * Dev and production differ only in the database NAME on the same host and
 * port, which is a very small env slip to make. Any test that mutates shared
 * rows calls this first so the slip fails loudly instead of silently taking
 * production with it.
 */

/** Production, and the ONE name that is always refused. */
const PROD_DB_NAME = 'isaflow';

/**
 * Every database name a mutating test or script may run against, stated in
 * full rather than derived from a prefix — `isaflow_prod_replica` starts with
 * the same eight characters as `isaflow_dev` and is not a thing to write to.
 *
 * `isaflow_staging` is a disposable `pg_dump` copy of production, restored on
 * demand, so it carries production-shaped DATA but nothing that matters is
 * lost when a run mutates it. It is on this list for that reason alone; the
 * production name itself is refused whatever else is added here.
 */
const ALLOWED_DB_NAMES = ['isaflow_dev', 'isaflow_test', 'isaflow_staging'];

/**
 * Throw unless DATABASE_URL names a dev/test database.
 *
 * Allow-list rather than deny-list: a deny-list only catches the exact
 * production name, so a URL pointing at some other live database would sail
 * through. `reason` is quoted in the failure so the operator can see what the
 * test would have done. An absent DATABASE_URL is not an error — the DB-gated
 * tests skip themselves in that case.
 */
export function assertNotProductionDb(reason: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, '').split('?')[0] ?? '';
  } catch {
    return; // Unparseable URL — isDbReachable will have skipped the test anyway.
  }
  if (name === PROD_DB_NAME || !ALLOWED_DB_NAMES.includes(name)) {
    throw new Error(
      `Refusing to run: DATABASE_URL names the database "${name}", which is not one of `
      + `${ALLOWED_DB_NAMES.join(' / ')}. ${reason} Point it at isaflow_dev.`,
    );
  }
}
