# K-096 — fix: activate the mandate the reference resolved to, not every pending one

**Trigger.** `GET /api/billing/paystack/mandate/verify` resolved one mandate through its
LEFT JOIN (`row.mandate_id`) and then wrote
`WHERE company_id = $1 AND status = 'pending' AND gateway = 'paystack'` — every pending
mandate. Migration 429's `ux_sub_mandates_company_active UNIQUE (company_id) WHERE
status = 'active'` makes the second row raise 23505. The route's `catch` logged that at warn
and continued, but the statement had already aborted the request transaction `withAuth`
opened, so the canonical re-read below raised 25P02 and the request 500'd. The customer
authorised and ended with nothing activated. Two pending mandates is what an
abandoned-then-retried checkout leaves behind.

**Before → after.** Before: company-wide UPDATE, 23505, poisoned transaction, 500. After:
both UPDATEs are scoped `WHERE id = ${row.mandate_id} AND company_id = ${req.companyId}` and
skipped when `mandate_id` is null; the failure branch additionally keeps `AND status =
'pending'`. The whole live-verify block runs inside `withSavepoint('paystack_mandate_verify')`
so any error it raises rolls back to the savepoint and leaves the request transaction usable
— the existing best-effort `catch` now actually is best-effort.

**Files.** `pages/api/billing/paystack/mandate/verify.ts`.

**Tests.** `tests/integration/k096-mandate-verify-activates-all-pending.int.test.ts` (1) and
`tests/integration/k096-mandate-verify-scoping.int.test.ts` (3) — real fixture DB, handler
driven inside a real BEGIN/ALS transaction the way `withAuth` runs it. 4 passed. Adjacent
cases: the abandoned sibling stays pending; another tenant's mandates are untouched; the
failed/abandoned branch marks only the resolved mandate. Mutation: reverting the production
file takes 2 of the 4 red (the other two do not reach the mutated statement). See `green.log`.

**Migration / rollback.** None. Rollback is reverting the one file.

**Historical-data impact.** Nothing wrong was written; the signature is a write that did not
happen. Any company with more than one pending paystack mandate cannot complete authorisation
through this route at all until the extra rows are cleared. Read-only, not executed here:

```sql
SELECT pr.company_id, pr.paystack_reference, pr.status AS request_status,
       COUNT(m.id) FILTER (WHERE m.status = 'pending') AS pending_mandates
FROM   paystack_payment_requests pr
LEFT   JOIN subscription_mandates m
       ON m.company_id = pr.company_id AND m.gateway = 'paystack'
WHERE  pr.purpose = 'authorization'
GROUP  BY pr.company_id, pr.paystack_reference, pr.status
HAVING COUNT(m.id) FILTER (WHERE m.status = 'active') = 0
   AND COUNT(m.id) FILTER (WHERE m.status = 'pending') > 1;
```

**Limits.** Stale pending mandates still accumulate — expiring them is a separate change.
The first SELECT's ordering decides which mandate wins when several are pending; it picks the
newest, i.e. the retry, which is the right one, but it is an ordering choice not a lock.
