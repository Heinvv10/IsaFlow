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

**Round 2 (blind review of fb63f304).** Two findings, both fixed here.

*HIGH-1 — the webhook was left broken.* The commit scoped `verify.ts` and left the identical
company-wide statement in `src/modules/billing/services/paystackEventHandlers.ts`, the path the
route's own comment calls the source of truth, with a wider predicate still
(`status IN ('pending','active')`). `processEvent` runs handlers in one transaction, so the
23505 rolled the whole event back, the webhook answered 500, and every Paystack redelivery hit
the same constraint — the mandate never activated through the webhook at all. It now resolves
one mandate id and writes only that row.

*MEDIUM-1 — `row.mandate_id` was a heuristic, not a link.* Nothing in the schema resolved a
reference to a mandate: `create.ts` passed the mandate id only in the Paystack *metadata*,
which `VerifyTransactionResult` does not expose. The LEFT JOIN was really picking the company's
newest pending paystack mandate, so verifying an *older* reference activated a *newer* mandate
— and the row that went live carried a `max_amount_cents` recurring-debit ceiling the customer
never authorised on that reference. Migration 651 adds
`paystack_payment_requests.mandate_id`, `create.ts` sets it, and both readers use it. The
column is nullable: rows written before 651 have no recoverable link and keep the
newest-pending fallback, now scoped to one row rather than the whole company.

*LOW-2.* A successful authorisation that resolves to no mandate row now logs a warning. The
reference is spent at that point (the block is gated on `pr_status = 'pending'`), so the route
would otherwise report `pending` forever with nothing said.

**Files.** `pages/api/billing/paystack/mandate/verify.ts`,
`pages/api/billing/paystack/mandate/create.ts`,
`src/modules/billing/services/paystackEventHandlers.ts`,
`scripts/migrations/sql/651_paystack_payment_request_mandate_id.sql`.

**Tests.** `tests/integration/k096-webhook-mandate-scoping.int.test.ts` (3) drives
`processEvent` against the real DB with two pending mandates: the linked mandate activates, the
abandoned sibling stays pending, exactly one active row remains, a pre-651 request still
resolves to one mandate, and another tenant is untouched. Reverting the handler to master takes
all 3 red with the 23505 the review reproduced.
`tests/integration/k096-mandate-link-persisted.int.test.ts` (3) proves `create.ts` writes the
link, that verify activates the LINKED mandate rather than the newest pending one (with the
ceiling that belongs to that reference), and that a link pointing at another tenant's mandate
activates nothing. Reverting `create.ts` takes 1 red; removing the link predicate from the
verify JOIN takes 2 red.
`tests/integration/k096-mandate-verify-activates-all-pending.int.test.ts` (1) and
`tests/integration/k096-mandate-verify-scoping.int.test.ts` (3) — real fixture DB, handler
driven inside a real BEGIN/ALS transaction the way `withAuth` runs it. 4 passed. Adjacent
cases: the abandoned sibling stays pending; another tenant's mandates are untouched; the
failed/abandoned branch marks only the resolved mandate. Mutation: reverting the production
file takes 2 of the 4 red (the other two do not reach the mutated statement). See `green.log`.

**Migration / rollback.** `651_paystack_payment_request_mandate_id.sql` — one nullable column
plus a partial index, `ADD COLUMN IF NOT EXISTS`, `ON DELETE SET NULL`. Applied to the fixture
DB. Rollback is `ALTER TABLE paystack_payment_requests DROP COLUMN mandate_id`; both readers
treat a missing link as the legacy case, so reverting the code without the column also works.
Prefix 651 taken from the register; recorded there.

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

**Limits.** Rows created before migration 651 still resolve by "newest pending", which is a
guess — it is now a guess that touches exactly one row instead of a statement that raises
23505, but it can still activate the wrong mandate for a company that has two pending rows from
before the migration. Nothing recovers the true link for those; it lived in Paystack metadata.
Stale pending mandates still accumulate — expiring them is a separate change.
