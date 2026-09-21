# K-100 — Admin bulk actions share one transaction with no savepoints

**Baseline:** origin/master `31fc2f10`; `bulk-action.ts` unchanged since the audited `5661d6f0`.

**Claim vs corrected trigger.** Claim confirmed as written. Precise trigger: `withAdmin` →
`withPlatformAdmin` opens one BEGIN for the request (`withPlatformAdmin.ts:118`), and
`pages/api/admin/companies/bulk-action.ts:55-99` loops over `company_ids` issuing bare `sql` writes
on that one transaction. The per-item `catch` records the failure and continues, but the first SQL
error has already aborted the transaction (25P02), so every later item fails too and the final
COMMIT degrades to a ROLLBACK. The route still answers 200 with a non-zero `processed`.

**Disposition: confirmed.**

**Evidence.** Executed. Two companies, the second with `trial_ends_at = '294276-12-31'` so
`+ 90 days` raises 22008 `timestamp out of range`. The run logged the 22008 for the poison company,
answered `200` with `processed: 1`, and the good company's `trial_ends_at` was still NULL
afterwards. Its `admin_audit_log` row is gone as well, so the discarded work leaves no trace.

**Reachability.** `POST /api/admin/companies/bulk-action`, both branches. The `suspend` branch has
the same shape (`suspendCompany` at line 57 inside a per-item try/catch); it rethrows only
`CriticalAuditError`, so any other per-item SQL error takes the identical path.

**RED test.** `tests/integration/k100-admin-bulk-action-shared-tx.int.test.ts` — 1 failed. It
asserts the response's own `processed: 1` against the database and finds the trial not extended
and no audit row. Output in `red.log`.

**Proposed fix.** Wrap each loop iteration in `withSavepoint` from `@/lib/neon`
(`sp_bulk_${index}`), so a failed item rolls back only its own writes and leaves the transaction
usable for the rest. Keep the existing `CriticalAuditError` rethrow outside the savepoint. Savepoint
names must stay under 31 characters. Once items are isolated, `processed` is honest.

**Historical impact.** Bulk suspends and trial extensions that reported partial success may have
written nothing at all. There is no residue to query: the audit rows rolled back with the data, so
the database cannot distinguish "never attempted" from "attempted and discarded". The evidence
would be in production request logs — a 200 response to `/api/admin/companies/bulk-action` whose
`errors` array is non-empty means the whole batch was lost.

**Risk.** Savepoints on the request connection must nest LIFO (postgresql-gotchas §36); the loop is
sequential, so this is safe. `withSavepoint` already marks the context unusable if its own rollback
fails, which the loop must not swallow.
