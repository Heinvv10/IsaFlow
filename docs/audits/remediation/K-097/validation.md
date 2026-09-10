# K-097 — a swallowed audit-log failure poisons the admin transaction

**Claim.** The catch hides the error while the transaction is already aborted, turning the
admin write into a 200 with no effect (`src/modules/admin/services/auditService.ts:78`).

**Corrected trigger.** `logAdminAction` wraps its `INSERT INTO admin_audit_log` in a
try/catch and rethrows only when the action is in `CRITICAL_ACTIONS`. For every other action
the error is logged and swallowed. The INSERT runs on the request's own connection —
`withPlatformAdmin` opens one transaction per request (`BEGIN` at `withPlatformAdmin.ts:118`)
and `sql` routes through the ALS client (`neon.ts:102-107`) — and it is **not** wrapped in a
savepoint, so the failed statement leaves the whole transaction aborted. Postgres answers a
COMMIT on an aborted transaction with `ROLLBACK` and no error, so the middleware's COMMIT
succeeds, the route has already written its 2xx, and the mutation is gone. The existing
guards do not cover this: `criticalAuditFailed` only fires for critical actions, and
`assertTxUsable`/`markTxUnusable` only fire when a *savepoint rollback* fails.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/admin/services/auditService.ts` lines 59–87.
- `git show origin/master:src/lib/auth/withPlatformAdmin.ts` lines 118 and 169 — the request
  transaction and its COMMIT.
- `git show origin/master:src/lib/neon.ts` lines 102–107 — `sql` uses the ALS client, with no
  savepoint around the statement.
- Executed: `tests/integration/k097-audit-log-failure-poisons-admin-tx.int.test.ts`. Inside a
  real request transaction it inserts a `flow_bundles` row, then calls the real
  `logAdminAction` with the non-critical action `flow.bundle.create` and a `details` payload
  carrying a NUL character (jsonb refuses it — a genuine INSERT failure on a real column, not
  a stub). 1 test, 1 failed: `expected [] to have a length of 1`. The other three assertions
  pass and are the point — `logAdminAction` threw nothing, `COMMIT` threw nothing, and the row
  is still gone. `red.log` in this directory.

**Reachability.** Every non-critical admin write has this shape: mutate, then log. Roughly
thirty call sites, e.g. `pages/api/admin/billing/flow-bundles.ts:56` (`flow.bundle.create`),
`flow-bundles/[id].ts:70,81`, `pages/api/admin/announcements.ts:69`,
`pages/api/admin/payroll/sars-codes/[code].ts:52`. The trigger is any failure of the audit
INSERT — a lock timeout, a constraint, a disk error, an oversized `target_id` against
`varchar(255)` — not the NUL specifically.

**Proposed minimal fix.** Give the audit write its own savepoint so its failure cannot reach
the outer transaction. `withSavepoint` already exists in this codebase for exactly this; wrap
the INSERT in `logAdminAction` with it, keeping the existing catch and the
`criticalAuditFailed` behaviour unchanged. Per the repo's own rule, a best-effort SQL
statement on a shared transaction needs its own savepoint — a bare catch does not roll the
statement back, it only hides that it failed.

**Historical-data impact.** Silent loss, and by construction it leaves no trace: the audit row
is absent (the INSERT failed) *and* the mutation is absent (rolled back), so there is nothing
to join against. There is no read-only query that recovers the lost writes. The nearest
signal is application logs — `logAdminAction failed` at error level from component
`auditService` — every one of which, for a non-critical action, marks a request whose entire
effect was discarded behind a success response. Grep the retained logs for that message to
bound the count.

**Risks.** A savepoint per audit write costs a round trip on every admin mutation. The
alternative — rethrowing for all actions — turns a bookkeeping failure into a user-visible
500 on every admin write, which is a larger behaviour change than the defect warrants.
