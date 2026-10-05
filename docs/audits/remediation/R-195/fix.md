# R-195: payment request and invoice must share a company

## G1 gate (before 854 merges)

The census must be run on prod (read-only) before 854 merges; non-zero rows stop the merge.

**Run 2026-10-05 ~10:45 SAST, read-only session on prod `isaflow`: 0 rows** (`g1-prod-census.log`).
Prod is PostgreSQL 15.8, so `ON DELETE SET NULL (customer_invoice_id)` is supported. Prod has
2,368 customer invoices (the UNIQUE build is small), 1 Paystack and 2 Stitch requests naming an invoice.

```sql
SELECT 'paystack' AS gateway, pr.id, pr.company_id AS request_company, ci.company_id AS invoice_company
FROM paystack_payment_requests pr JOIN customer_invoices ci ON ci.id = pr.customer_invoice_id
WHERE pr.company_id <> ci.company_id
UNION ALL
SELECT 'stitch', sr.id, sr.company_id, ci.company_id
FROM stitch_payment_requests sr JOIN customer_invoices ci ON ci.id = sr.customer_invoice_id
WHERE sr.company_id <> ci.company_id;
```

Expected 0 rows. The fixture returns 0; prod returned 0 (above).

## PG version

`ON DELETE SET NULL (customer_invoice_id)` (a column list) needs PostgreSQL 15+. The fixture is 16.15.
Prod is 15.8 (G1). On 14 or older, 854 fails with a syntax error and the
runner rolls the whole file back (nothing half-applied). A plain `ON DELETE SET NULL` is wrong: it would
also null `company_id`, which is NOT NULL (mutant M2 below).

## Claim

Verified on the fixture before the fix (red.int.log at 69ab01de2): as app_user, a request in company B
naming company C's invoice was stored, for both gateways. R-186's own pin showed C's archive then failing
whole on 23514 (`paystack_pr_invoice_has_invoice` / `stitch_pr_invoice_has_invoice`).

## Root cause

`customer_invoice_id` on both request tables is a single-column FK. Nothing tied the request's
`company_id` to the invoice's. RLS on the request tables admits every company the user belongs to.

## Fix

Migration `scripts/migrations/sql/854_payment_request_invoice_company_fk.sql`:

- UNIQUE `customer_invoices_id_company_id_key (id, company_id)`, guarded by a `pg_constraint` check.
- `paystack_payment_requests_invoice_company_fkey` and `stitch_payment_requests_invoice_company_fkey`:
  `(customer_invoice_id, company_id) REFERENCES customer_invoices (id, company_id) ON DELETE SET NULL
  (customer_invoice_id)`, added NOT VALID. ON UPDATE is NO ACTION, as on the existing FK.
- A DO block counts cross-company rows per table. 0: `VALIDATE CONSTRAINT`. Otherwise: FK stays NOT
  VALID (still enforced for new and changed rows) and a NOTICE names the count. No data is changed.
- `SET LOCAL lock_timeout = '5s'`, `statement_timeout = '120s'`, as 852. The runner
  (`scripts/apply-migrations.ts`) wraps each file in one transaction, so CONCURRENTLY is not possible and
  NOT VALID + VALIDATE in the same file buys no lower lock; it only makes the validate conditional.

The single-column FKs are kept. They are validated today, so they still guarantee the invoice exists if a
composite FK is ever left NOT VALID. On delete both fire, in an unspecified order (RI triggers fire in
name order, a text compare of OID-based names). Both null only `customer_invoice_id`, so either order
leaves the same row and delete behaviour is unchanged: an invoice-purpose request still blocks the delete
on 23514, and any other purpose loses only its invoice id. When the single-column FK fires first, it also
hides a wrong ON DELETE on the composite FK (M2), so one test drops the single-column FK in a rolled-back transaction and proves
the composite FK alone keeps `company_id`.

Applied to the fixture `isaflow_schema_fixture` and `isaflow_test` (schema_migrations row inserted as the
runner does: version, name, sha256 checksum).

## Writers checked

- `src/modules/accounting/services/ar/portalLinkCharge.ts` `recordStartingCheckout`: the only production
  writer of a `customer_invoice_id`. `companyId` and `invoiceId` both come from the same `customer_invoices`
  row in `resolveLinkCharge` (`ci.id`, `ci.company_id`). Consistent.
- `subscriptionBillingService.ts`, `pages/api/billing/flows/purchase.ts`,
  `pages/api/billing/paystack/mandate/create.ts`: insert into `paystack_payment_requests` without
  `customer_invoice_id` (NULL; MATCH SIMPLE skips the FK).
- No production code inserts into `stitch_payment_requests`.

No writer the FK would turn into a 500.

## Tests

`tests/integration/r195-payment-request-invoice-company-fk.int.test.ts` (real PG, inserts as app_user):
per gateway, cross-company insert refused 23503 with the new constraint; same-company accepted; delete
of an invoice-purpose request's invoice still 23514; other purpose loses only its invoice id; composite FK
alone keeps `company_id`. Migration: clean DB gives all three constraints validated and a re-run changes
nothing; a forged row per table leaves that FK NOT VALID, the other validated, the NOTICE, row untouched.

`tests/integration/r186-archive-skips-paystack-invoices.int.test.ts`: the forged cross-company requests
are gone from `beforeAll`; the cross-tenant case now asserts the insert is refused (23503) and that C's
archive then archives its invoice.

- red.int.log (69ab01de2, no migration): 7 failed, 8 passed (15). The 4 ON DELETE pins passed before the
  fix: that is the baseline they hold.
- green.int.log (35ede58f9): 17 passed (17).
- regression.int.log (35ede58f9): all five r186 suites, 24 passed (24).

## Mutants (mutations.log)

Each applied to 854 on disk and to the fixture, run, reverted with `git checkout`, real 854 re-applied.

- M1 single-column FK (company dropped): 7 failed / 15.
- M2 plain `ON DELETE SET NULL`: 3 failed / 15 (definition pins only: behaviour masked by the kept FK).
- M2b same, after adding the composite-FK-alone test: 5 failed / 17 (23502 on `company_id`).
- M3 never VALIDATE: 3 failed / 15.
- M4 VALIDATE unconditionally: 2 failed / 15.

Final green after the mutants: green.int.log, 17/17; re-run independently by the orchestrator after the
mutants: baseline-after-mutants.int.log, 17/17.

## Residual risk

- Prod census: 0 rows, PG 15.8 (G1, above).
- If prod already has a non-constraint index named `customer_invoices_id_company_id_key`, the ADD fails
  and the file rolls back. Not expected.
- ADD CONSTRAINT UNIQUE takes ACCESS EXCLUSIVE on `customer_invoices` (blocks invoice reads and
  writes), held to COMMIT through the build, both census scans and both VALIDATEs; bounded by the 120s
  statement_timeout. Prod has 2,368 invoices.
- Lock order: request tables first, then `customer_invoices` (see Review round 1). The portal checkout
  takes them in the opposite order, so a deadlock with a checkout in flight stays possible; one side
  is aborted (40P01) and retried.
- `customer_invoices.company_id` can no longer be changed while a request references the invoice
  (ON UPDATE NO ACTION). No code changes it.

## Review round 1

Blind review of 5938c3de4: FIX, 7 LOW. All fixed in 1ab99b9c3.

- Lock level. `ADD CONSTRAINT ... UNIQUE` takes ACCESS EXCLUSIVE on `customer_invoices` (measured on the
  fixture: `AccessExclusiveLock` + `ShareLock`), not SHARE. Invoice reads block too, until COMMIT. The 854
  header and the residual-risk line now say so.
- Lock order. 854 now runs `LOCK TABLE paystack_payment_requests, stitch_payment_requests IN SHARE ROW
  EXCLUSIVE MODE` before the UNIQUE add. The settlement path (`handleChargeSuccess`, portal verify) UPDATEs
  `paystack_payment_requests` and then works on the invoice, so this matches it. lock-order.r1.log: with a
  ROW EXCLUSIVE held on the request table, 854 waits on it and holds nothing on `customer_invoices`.
  Without the LOCK TABLE (mutant R4) it waits while already holding ACCESS EXCLUSIVE on `customer_invoices`:
  the deadlock shape. The portal checkout (`claimCheckout`) reads the invoice and then writes a request,
  the opposite order. A deadlock with a checkout in flight is still possible. Postgres aborts one side
  (40P01): either the runner rolls 854 back whole, or the payer clicks again. Recorded in the 854 header.
- Trigger order. RI triggers fire in name order (`RI_ConstraintTrigger_a_<oid>`, a text compare), so the
  order is unspecified. Both FKs null only `customer_invoice_id`, so either order leaves the same row.
  Reworded in 854, fix.md, core `.claude.md` and the r195 test comment.
- Stale "not queried / not checked from here" lines replaced by the G1 result.
- `archiveCustomerInvoiceScope.ts` header: a cross-tenant request is now refused at insert (R-195).
- r186 preview: new case. In a rolled-back transaction it drops both composite FKs and forges a Paystack
  and a Stitch request of B on C's invoice. C's preview must still count 1 and skip 0. `drive` takes a
  `setup` hook that runs first, as postgres.
- Timeouts: the clean-DB migration test asserts `lock_timeout = 5s`, `statement_timeout = 2min` after
  each run of 854.

Logs (r1):
- green.r1.int.log (1ab99b9c3): 18/18.
- regression.r1.int.log, all 5 r186 suites: 25/25.
- mutations.r1.log:
  - R1, Paystack company predicate dropped: 1 of 18 red (preview skip).
  - R2, Stitch company predicate dropped: 1 of 18 red (preview skip).
  - R3, SET LOCAL timeouts deleted: 1 of 18 red (timeouts '0').
  - R4, LOCK TABLE removed: lock-order probe shows AccessExclusive on `customer_invoices` granted while
    waiting on the request table. This is a probe, not a vitest case.
- baseline-after-mutants.r1.int.log: 18/18.

The 854 file changed, so its checksum changed. It was re-applied to both fixture DBs with the new
checksum. I applied it only to the fixture.
