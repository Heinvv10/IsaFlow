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

**Round 2 (blind review of fb63f304) — MEDIUM-2.** The savepoint changes what membership of
`CRITICAL_ACTIONS` means. Before it, an audit failure on ANY action discarded the mutation
(badly, behind a 2xx, but discarded). After it, an action outside the set commits its mutation
unaudited. The first commit fixed the set's naming and not its coverage: of the 51 action
literals emitted across `pages/` and `src/`, seven privileged ones were absent, including
`flow.adjust` (`pages/api/admin/billing/payg/[companyId]/adjust.ts`), which manually credits or
debits a company's Flow wallet, and `user.delete`. Those seven are now in the set:
`flow.adjust`, `user.delete`, `company.create`, `subscription.create`, `trial.convert_to_paid`,
`plan.create`, `invoice.mark_paid`. They are money movement, identity destruction, or the start
of billing, and each has an update/cancel counterpart already in the set.

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
`tests/unit/services/adminCriticalActions.test.ts` (3) enumerates the action literals
actually emitted across `src/` and `pages/` and requires every `CRITICAL_ACTIONS` entry to be
one of them, with a guard so the scan cannot pass vacuously. Its scan no longer takes
"everything before the first comma" as the first argument (LOW-3): that regex misses a call
like `logAdminAction(resolveActor(req, ctx), 'user.suspend', …)` and the miss is silent, so a
real CRITICAL entry would look orphaned. It now walks the argument list and splits on the first
comma at depth zero, with a case asserting both shapes the regex got wrong.
The `it.each` block in `k097-audit-savepoint-adjacent.int.test.ts` drives a real failing INSERT
for each of the seven newly critical actions and asserts `CriticalAuditError` plus
`criticalAuditFailed`; dropping any one of them from the set takes that case and the unit
guard red (verified for `flow.adjust`).
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

**Limits.** A savepoint costs a round trip on every admin mutation. Nine actions moved into
`CRITICAL_ACTIONS` across both rounds, so an audit-write failure on any of them now surfaces as
a 500 rather than a silently unlogged change. That is the intent of the set, but it is a
behaviour change on live admin routes.

The set still excludes actions a reviewer could reasonably argue for — `user.add_to_company`
and `user.remove_from_company` grant and revoke access to a tenant's data, `webhook.delete`,
`impersonation_end`, `company.extend_trial`. They are left best-effort deliberately: the seven
added here are the ones the blind review named and assessed, and widening further without that
assessment trades one silent failure for an unmeasured 500 surface. Whoever next opens this
file should decide on those five explicitly.
