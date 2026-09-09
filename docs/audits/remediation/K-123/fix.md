# K-123 — listDisputes reports the matching count, not the page size

**Trigger.** `listDisputes` returned `total: disputes.length`, the length of the LIMIT-ed page, and
issued no COUNT(*). Any API/MCP consumer paging on `total` stopped at page one.

**Before.** 3 open disputes, `limit: 2` → `total` 2.
**After.** A single COUNT(*) repeating the branch predicates (company, optional status, optional
invoice) with no LIMIT/OFFSET; `total` is `Number(countRows[0]?.cnt ?? 0)`. The nullable filters are
passed once each and guarded with `${x}::text IS NULL OR ...`, so one query covers all four branches
without adding a fifth copy of the SELECT to an already 400-line file.

**Files.** `src/modules/accounting/services/ar/disputeService.ts` (`listDisputes` return block).

**Tests.** `tests/integration/k123-list-disputes-total.int.test.ts` — 5 passed (real DB): true total
behind a page, status-filtered count, page past the end, single-invoice filter, other tenant sees 0.
Mutation check: restoring `total: disputes.length` → 3 failed.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** None — nothing is written and no row was read incorrectly; only the
reported count was wrong.

**Limits.** One extra query per list call. The disputes UI page has no pager, so it still truncates
at the default limit of 50; that is a separate UI gap, not fixed here.

**Existing suite.** `tests/unit/services/ar/disputeService.test.ts` mocks `sql`; the two `listDisputes`
tests now queue a row for the COUNT(*) as well. Full unit suite green: 9563 passed / 243 skipped.
