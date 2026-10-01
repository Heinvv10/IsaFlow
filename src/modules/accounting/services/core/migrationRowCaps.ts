/**
 * Rows one migration request may carry. The import and the execute hold the
 * company's role-write lock (systemRoleWriteLock) until their request
 * commits, and every other writer of the company's chart waits at most 5s for
 * it before answering 503 — so a request has to finish well inside that.
 *
 * Sized from real charts, not guessed: the largest chart on isaflow_dev has
 * 152 accounts, 91 customers and 59 suppliers (2026-10-01); production charts
 * in docs/mcp/FINDINGS.md are 111-118 accounts. The caps are several times
 * that, and a larger book is migrated in more than one request.
 */
export const MAX_MIGRATION_ACCOUNTS = 1000;
export const MAX_MIGRATION_CONTACTS = 2000;

/** Why these arrays are too large for one request, or null. */
export function migrationSizeError(sizes: { accounts?: number; customers?: number; suppliers?: number }): string | null {
  if ((sizes.accounts ?? 0) > MAX_MIGRATION_ACCOUNTS) {
    return `At most ${MAX_MIGRATION_ACCOUNTS} accounts per request (got ${sizes.accounts}); split the chart into several imports.`;
  }
  for (const kind of ['customers', 'suppliers'] as const) {
    if ((sizes[kind] ?? 0) > MAX_MIGRATION_CONTACTS) {
      return `At most ${MAX_MIGRATION_CONTACTS} ${kind} per request (got ${sizes[kind]}); split them into several requests.`;
    }
  }
  return null;
}
