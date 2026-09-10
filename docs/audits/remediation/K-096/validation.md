# K-096 — one authorisation activates every pending mandate

**Claim.** Authorisation promotes all pending mandates for the company, violating the
single-active-mandate index and stranding retried checkouts
(`pages/api/billing/paystack/mandate/verify.ts:73`).

**Corrected trigger** (plan correction H50/F13, verified against the fixture schema). The
route resolves one mandate through its LEFT JOIN (`row.mandate_id`, line 47) and then updates
`WHERE company_id = $1 AND status = 'pending' AND gateway = 'paystack'` — every pending
mandate, not the one the reference belongs to. Migration 429 defines
`ux_sub_mandates_company_active UNIQUE (company_id) WHERE status = 'active'`, confirmed
present in the fixture (`\d subscription_mandates`). So the outcome is **not** several active
mandates: the UPDATE raises 23505 partway through. The route's own `catch` logs that at
`warn` and continues, but `withAuth` has already opened the request transaction on this
connection, so the aborted statement poisons it. The next statement — the route's own
"re-read the canonical state" SELECT at line 109 — raises 25P02 and the request 500s and rolls
back. The customer authorised a mandate and ends with nothing activated.

**Disposition: confirmed**, with the claimed *consequence* corrected as above.

**Evidence.**
- `git show origin/master:pages/api/billing/paystack/mandate/verify.ts` lines 44–101.
- `git show origin/master:scripts/migrations/sql/429_stitch_payments.sql:103` — the index.
- Executed: `tests/integration/k096-mandate-verify-activates-all-pending.int.test.ts`. Two
  pending paystack mandates (an abandoned checkout and the retry), one `authorization`
  payment request, `verifyTransaction` stubbed to a successful authorisation, the handler run
  inside a real `BEGIN`/ALS transaction the way `withAuth` runs it. 1 test, 1 failed:
  `expected 500 to be 200`. The run log carries both halves of the chain —
  `Paystack mandate live verify failed ... duplicate key value violates unique constraint
  "ux_sub_mandates_company_active"`, then
  `current transaction is aborted, commands ignored until end of transaction block` at
  `verify.ts:109`. `red.log` in this directory.

**Reachability.** `GET /api/billing/paystack/mandate/verify?ref=...`, `withAuth`, called by
the mandate-return landing page. It needs two pending paystack mandates on one company, which
is what an abandoned-then-retried checkout produces.

**Proposed minimal fix.** Scope the writes to the mandate already resolved. `row.mandate_id`
is in hand from the first SELECT: change both UPDATEs to
`WHERE id = ${row.mandate_id} AND company_id = ${req.companyId}` (and skip the block when
`row.mandate_id` is null). Two lines, and it fixes the failure path as well — today the
`failed`/`abandoned` branch marks *every* pending mandate failed, including one the user is
mid-way through authorising. Separately, the `catch` at line 102 should not swallow a database
error on a shared transaction; let it propagate so the 500 names its cause.

**Historical-data impact.** Nothing wrong was written — the defect's signature is writes that
did *not* happen. Look for authorisations that completed at Paystack and left the mandate
behind, read-only:

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

Any company with more than one pending paystack mandate is currently unable to complete
authorisation through this route at all — every call 500s until the extra rows are cleared.

**Risks.** Scoping to `row.mandate_id` changes which mandate wins when several are pending;
the ordering in the first SELECT (`(m.status='active') DESC, m.created_at DESC`) picks the
newest, which is the retry, and that is the right one. Stale pending rows still accumulate —
worth expiring them, but that is a separate change.
