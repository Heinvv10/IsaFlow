# K-097 — fix: the audit write gets its own savepoint

**Trigger.** `logAdminAction` wrapped its `INSERT INTO admin_audit_log` in a try/catch and
rethrew only for `CRITICAL_ACTIONS`. The INSERT runs on the request's own connection —
`withPlatformAdmin` opens one transaction per request and `sql` routes through the ALS client
— with no savepoint. So a failed INSERT for a non-critical action left the whole transaction
aborted; Postgres answers a COMMIT on an aborted transaction with a silent ROLLBACK, the
route had already written its 2xx, and the admin mutation the log entry described was gone.
A bare catch does not roll a statement back, it only hides that it failed.

**Before → after.** Before: audit INSERT fails → transaction aborted → mutation silently
discarded behind a 200. After: the INSERT runs inside
`withSavepoint('admin_audit_log_write')`, so its failure rolls back to the savepoint and the
mutation commits. The existing catch, the `CriticalAuditError` rethrow and the
`criticalAuditFailed` context flag are unchanged.

**Adjacent correction (in the same file).** `CRITICAL_ACTIONS` named three actions no call
site emits — `user.impersonate`, `feature.override`, `feature.remove_override` — so the two
company feature-flag overrides, which do emit `company_feature.override_set` /
`company_feature.override_removed`, were being treated as best-effort. Left alone, the
savepoint fix would have made that silence permanent instead of merely invisible. The set now
names only emitted actions and the two override actions are critical. `CRITICAL_ACTIONS` is
exported so a test can assert it.

**Files.** `src/modules/admin/services/auditService.ts`.

**Tests.** `tests/integration/k097-audit-log-failure-poisons-admin-tx.int.test.ts` (1) and
`tests/integration/k097-audit-savepoint-adjacent.int.test.ts` (3) — real fixture DB, a real
INSERT failure (a NUL character jsonb refuses) inside a real request transaction. 4 passed.
`tests/unit/services/adminCriticalActions.test.ts` (2) enumerates the action literals
actually emitted across `src/` and `pages/` and requires every `CRITICAL_ACTIONS` entry to be
one of them, with a guard so the scan cannot pass vacuously.
`tests/unit/services/admin/auditService.test.ts` (pre-existing, 6 passed) needed its
`@/lib/neon` mock extended with `withSavepoint`, and its assertion on the dead name
`user.impersonate` moved to `company.impersonate`. Mutation: reverting the production file
takes 3 of 4 integration tests and both unit tests red. See `green.log`.

**Migration / rollback.** None. Rollback is reverting the one file.

**Historical-data impact.** By construction there is no trace: the audit row is absent
because the INSERT failed, and the mutation is absent because it was rolled back, so nothing
joins to anything. No read-only query recovers the lost writes. The only signal is retained
application logs — `logAdminAction failed` at error level from component `auditService`; for
a non-critical action every one of those marks a request whose entire effect was discarded
behind a success response. Grepping those logs bounds the count.

**Limits.** A savepoint costs a round trip on every admin mutation. Making the two feature
overrides critical means an audit-write failure on them now surfaces as a 500 rather than a
silently unlogged change — that is the intent of the set, but it is a behaviour change.
