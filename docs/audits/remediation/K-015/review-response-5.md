# K-015 — migration 625 withdrawn as a unique index

The deploy pre-flight probe against production (run by the team lead; this session does not touch
the production database) found that the unique index could not be built: the Demo company alone
holds five or more groups of 55 to 79 approved or paid supplier invoices sharing a single
`duplicate_fingerprint`. The index would have aborted the deploy before the rsync. The evidence
decides it — the fingerprint is not a per-document identity and cannot carry a constraint.

## What changed

**1. Migration 625 is now a non-unique lookup index.** Renamed to
`625_supplier_invoice_duplicate_fingerprint_lookup.sql`, it creates
`idx_supplier_invoices_supplier_fingerprint` on `(company_id, supplier_id, duplicate_fingerprint)`,
partial on `duplicate_fingerprint IS NOT NULL`, which is exactly how
`captureDeduplicationService.findDuplicate` probes. The `DO $$` pre-flight guard is gone with the
uniqueness it protected. `idx_supplier_invoices_duplicate_fp` (migration 412) is kept: it leads
`(company_id, duplicate_fingerprint)` without `supplier_id`, which the new index cannot serve.

**2. The wizard's idempotency is a lookup, not a constraint.** `importAPInvoices` no longer uses
`ON CONFLICT`. Before inserting, it asks whether this company already has a live bill for this
supplier with this fingerprint, and reports the row as an already-imported skip if so. The
behaviour the operator sees is unchanged and the same test proves it. This is a read-then-write
and is therefore not safe against two imports of the same file at the same instant — there is no
constraint left to lean on, and the wizard is one operator-driven step per company. Stated in the
code and here rather than left to be discovered.

**3. Everything that depended on the unique violation is removed, not left dead.**
`rethrowDuplicateFingerprint`, `insertNamingDuplicate` and `isDuplicateFingerprintViolation` are
deleted, and `supplierInvoiceService`, `recurringTransactionService` and `sageImportService` are
back to plain inserts. Code that can never fire is worse than no code: it reads as a guarantee.

**4. The Sage per-record savepoint stays.** Its original trigger (a 23505 from the unique index) is
gone, but the hazard is generic: any SQL failure on a record aborted the request transaction, so
the catch's `migration_status` marker raised 25P02, escaped to `failRun()` and rolled back every
invoice the run had imported. The test now drives it with a 22007 instead, and asserts the
un-savepointed sequence still dies, so it measures something real.

**5. The AP 42P10 guard is removed** — with no `ON CONFLICT` in that statement it could not fire.
The AR guard stays: that insert still names `uq_customer_invoices_company_number`, a constraint
that has existed since long before this branch.

## Register item: `duplicate_fingerprint` is not a per-document key

It is `lower(vat_number|invoice_number|total_amount)` with the literals `no-vat`, `no-inv` and `0`
substituted for missing parts. Both producers agree on this — migration 412's backfill:

```sql
lower(coalesce(s.vat_number,'no-vat') || '|' || coalesce(si.invoice_number,'no-inv')
      || '|' || coalesce(si.total_amount::text,'0'))
```

and `computeFingerprint` in `captureDeduplicationService.ts`, which builds the same string. So any
set of rows missing the same parts collapses onto one value: a supplier with no VAT number billing
repeatedly with no invoice number and a zero total yields `no-vat|no-inv|0` for every one of them.
That is consistent with the production groups of 55-79, and a test now asserts the collapse
directly on the real database.

**Whether it should be per-document is a real question and I have not answered it here.** Adding
the invoice date, or the source document id, would make it discriminating — and would also change
what every existing duplicate check in the system considers a duplicate, on data already stored.
That is a decision with a scope far wider than an import fix. Recorded for the register; the lead
said they will register it.

## Verification

Migration 625 re-applied to the fixture in its non-unique form. 28 integration tests on real
PostgreSQL, two mutation checks on the new lookup (removing it, and dropping its `deleted_at`
predicate) both red. Full unit suite green — its AP mock queue is positional and needed the new
lookup inserted, which is the breakage the full-suite gate exists to catch.
