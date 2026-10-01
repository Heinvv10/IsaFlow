/**
 * Rows one migration request may carry. The import and the execute hold the
 * company's role-write lock (systemRoleWriteLock) until their request commits,
 * and every other writer of the company's chart waits at most 5s for it before
 * answering 503 — so the caps bound TIME, through counts that were measured.
 * The target is a worst case under 3 s.
 *
 * Measured 2026-10-01 THROUGH THE ROUTES (withAuth: the app role, RLS on) on
 * the disposable fixture — pgvector/pg16 container on velo-server, load average
 * 11-15 — three runs each, request in to response out:
 *   COA import      5,000 accounts    1.74 - 1.91 s
 *                   7,500             2.22 - 2.44 s   <- MAX_IMPORT_ACCOUNTS
 *                  10,000             3.32 - 3.68 s   (over)
 *   execute         accounts + customers + suppliers
 *                   2,000 + 2,000 + 2,000     0.76 - 1.38 s
 *                   3,000 + 2,000 + 2,000     1.16 - 1.74 s   <- the execute caps
 *                   5,000 + 1,000 + 1,000     1.66 - 1.97 s
 *                   5,000 + 2,000 + 2,000     2.88 - 3.47 s   (over)
 *                  10,000 + 5,000 + 5,000     3.54 - 4.12 s   (over)
 * Called as a service on a superuser connection (no RLS) the same work is
 * 2-3 times faster — 10,000 accounts import in 1.35 - 2.20 s — so measure the
 * route, not the service, before raising a cap, and write the result here.
 * The supplier figures are NOT measured: executeMigration's supplier insert
 * names a column the table does not have and fails at once (pre-existing), so
 * the runs above carry the cost of the customers only; suppliers are assumed
 * to cost what customers do (5,000 customers alone: 0.40 - 0.46 s).
 * For scale: the largest chart on isaflow_dev has 152 accounts, 91 customers
 * and 59 suppliers.
 */
export const MAX_IMPORT_ACCOUNTS = 7_500;
export const MAX_EXECUTE_ACCOUNTS = 3_000;
export const MAX_EXECUTE_CONTACTS = 2_000;

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
