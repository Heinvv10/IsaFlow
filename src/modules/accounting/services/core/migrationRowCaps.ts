/**
 * Rows one migration request may carry. The import, the execute and the
 * rollback hold the company's role-write lock (systemRoleWriteLock) until
 * their request commits, and every other writer of the company's chart waits
 * at most 5s for it before answering 503 — so the caps bound TIME, through
 * counts that were measured. The target is a worst case near 2.5 s ON A LOADED
 * HOST: half of what the others wait.
 *
 * Measured 2026-10-01 THROUGH THE ROUTES (withAuth: the app role, RLS on) on
 * the disposable fixture (pgvector/pg16 container on velo-server, 32 cores),
 * request in to response out, six runs each: three at load average 15-20 and
 * three with a second test suite running alongside (load average 20-27).
 * Lowest - highest of the six:
 *   COA import      4,000 accounts            1.27 - 2.96 s  (insert, update, and a second 4,000)
 *                   7,500 (the earlier cap)   2.22 - 2.44 s at load 11-15; the
 *                                             breaker saw 3.0 - 4.9 s at load ~35
 *                   3,000                     1.30 s (one run, the at-cap test); scaled
 *                                             from 4,000: under 2.3 s           <- MAX_IMPORT_ACCOUNTS
 *   execute         accounts + customers + suppliers
 *                   1,500 + 1,000 + 1,000     0.79 - 1.59 s
 *                   2,000 + 1,000 + 1,000     1.02 - 2.57 s   <- the execute caps
 *                   2,000 + 2,000 + 2,000     1.14 - 2.66 s
 *                   3,000 + 2,000 + 2,000     1.55 - 3.59 s  (the earlier caps: over)
 *   rollback, one account at a time (its fallback when the single DELETE is
 *   refused by a foreign key)
 *                   1,000 accounts            0.45 - 0.73 s
 *                   2,000                     0.86 - 1.61 s   <- MAX_ROLLBACK_LOOP_ACCOUNTS
 *                   3,000                     1.27 - 2.72 s
 * Load moves these by a factor of two, and an idle fixture or the bare service
 * on a superuser connection (no RLS) is 2-3 times faster again: measure the
 * ROUTE on a busy host before raising a cap, and write the result here.
 * NOT covered by a row cap: time that grows with the company rather than the
 * request (the VAT-lock check reads the posted lines of the accounts changed).
 * Suppliers measured 2026-10-02 (the supplier insert named a column the table
 * lacks and failed at once until then), through the service on a superuser
 * connection (no RLS), load average 33-35, three runs each: 1,000 suppliers
 * alone 94 - 120 ms, 1,000 customers alone 89 - 243 ms, and the full execute
 * cap 2,000 + 1,000 + 1,000 454 - 506 ms. They cost what customers do.
 * For scale: the largest chart on isaflow_dev has 152 accounts, 91 customers
 * and 59 suppliers.
 */
export const MAX_IMPORT_ACCOUNTS = 3_000;
export const MAX_EXECUTE_ACCOUNTS = 2_000;
export const MAX_EXECUTE_CONTACTS = 1_000;
/**
 * How many accounts a rollback works through ONE AT A TIME in a request. The
 * rest keep their import tag and are reported as `remaining`: running the
 * rollback again continues.
 */
export const MAX_ROLLBACK_LOOP_ACCOUNTS = 2_000;

const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const tooMany = (what: string, got: number, cap: number, how: string) =>
  `This request has ${fmt(got)} ${what} and one request takes at most ${fmt(cap)}. ${how}`;

/** Why a COA import is too large for one request — and what to do about it — or null. */
export function importSizeError(accounts: number): string | null {
  return accounts <= MAX_IMPORT_ACCOUNTS ? null : tooMany('accounts', accounts, MAX_IMPORT_ACCOUNTS,
    `Split the chart into files of up to ${fmt(MAX_IMPORT_ACCOUNTS)} accounts and import them one after the other, parent accounts first `
    + '(an account imported twice is updated, not duplicated).');
}

/** Why a migration execute is too large for one request — and what to do about it — or null. */
export function executeSizeError(sizes: { accounts: number; customers: number; suppliers: number }): string | null {
  if (sizes.accounts > MAX_EXECUTE_ACCOUNTS) {
    return tooMany('accounts', sizes.accounts, MAX_EXECUTE_ACCOUNTS,
      `Run the migration in batches of up to ${fmt(MAX_EXECUTE_ACCOUNTS)} accounts (an account sent twice is updated, not duplicated).`);
  }
  for (const kind of ['customers', 'suppliers'] as const) {
    if (sizes[kind] > MAX_EXECUTE_CONTACTS) {
      return tooMany(kind, sizes[kind], MAX_EXECUTE_CONTACTS, `Run the migration in batches of up to ${fmt(MAX_EXECUTE_CONTACTS)} ${kind}.`);
    }
  }
  return null;
}
