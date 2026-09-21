# K-099 — withPlatformAdmin commits on every 4xx

**Baseline:** origin/master `31fc2f10`. `withPlatformAdmin.ts` changed once since `5661d6f0`
(`23608ad7`, impersonation through MFA gates); the commit path is unchanged.

**Claim vs corrected trigger.** Claim holds, with one correction to its reach: the COMMIT at
`src/lib/auth/withPlatformAdmin.ts:169` is unconditional, but only a handler that answers 4xx
**without** raising a SQL error persists its write. A handler that 4xx's because a query failed
has already aborted the transaction, so the COMMIT degrades to a ROLLBACK and nothing survives —
that is the K-100 failure, not this one.

**Disposition: confirmed.**

**Evidence.** `withPlatformAdmin.ts:169` COMMITs once the handler returns; the only rollback paths
are a thrown error (line 171) and `ctx.criticalAuditFailed` (line 153). `res.statusCode` is never
read. `withAuth` does read it and rolls back on `>= 500` (`src/lib/auth/withAuth.ts:224`), so the
two middlewares disagree on the same question.

**Reachability.** Every admin route wraps `withAdmin` → `withPlatformAdmin`
(`src/modules/admin/middleware/withAdmin.ts:35`), and the validate-after-write and
catch-then-`badRequest` shapes are used throughout `pages/api/admin`. The closest natural instance
I found is `pages/api/admin/users/[id].ts:57-62` — `updateUser` writes, then a null re-read
answers 404 — but I could not reach that branch with a real write, because `getUserDetail` returns
null only when the users row is absent, in which case `updateUser` wrote nothing. So I proved the
middleware contract directly rather than through a route, and I am not claiming an executed
end-to-end route reproduction.

**RED test.** `tests/integration/k099-platform-admin-commits-on-4xx.int.test.ts` — 1 failed,
1 passed. The passing test is the 200 control proving the middleware commits normally; the failing
one writes a row and answers 400, and the row survives. Output in `red.log`.

**Proposed fix.** In `withPlatformAdmin.ts`, mirror `withAuth`: before line 169, choose
`res.statusCode >= 400 ? 'ROLLBACK' : 'COMMIT'`. Admin routes have no legitimate write-then-4xx
case, so rolling back on any 4xx is safer here than `withAuth`'s `>= 500` threshold. Log the
rollback with the status so an operator can see a discarded admin edit.

**Historical impact.** Partial admin edits may have persisted behind 4xx responses since the
middleware was written. Nothing in the database distinguishes them, because the audit row for the
action was never written on those paths. Only the request logs (journald request bodies) would
show a 4xx admin mutation. No safe read-only SQL exists for this.

**Risk.** Rolling back on 4xx changes behaviour for any admin route that intentionally writes and
then answers 4xx. I found none, but the change should be reviewed against every `pages/api/admin`
route that both writes and returns a 4xx.
