# K-015 / K-089 — migration wizard wrote columns that do not exist

**Trigger.** `importAPInvoices` and `importARInvoices` INSERT `balance_due`; no table in the
schema has that column (`balance` is GENERATED as `total_amount - amount_paid`). The AR INSERT
also wrote `reference`, which `customer_invoices` does not have either. Every row raised 42703,
the per-row `catch` counted it `skipped`, and the aborted transaction made the closing
`updateSession` raise 25P02 — so both wizard steps returned 500 and imported nothing.

**Before.** POST /api/accounting/migration/{ap,ar}-invoices: 500, 0 rows, `skipped` = row count.
**After.** Rows import. `balance` is left to the generated column; the source reference goes to
`supplier_invoices.reference` (AP) and `customer_invoices.external_ref` (AR, migration 530).
Each row now runs inside its own savepoint, so a row that genuinely fails is contained: it is
counted `skipped` with an error, the remaining rows still import, and `updateSession` survives.
`imported`/`skipped` are now decided by the row's real outcome, not by reaching the end of a block.

**Files.**
- `src/modules/accounting/services/ap/migrationApService.ts`
- `src/modules/accounting/services/core/migrationImportService.ts`

**Tests.** Real PostgreSQL, service driven inside the single request transaction `withAuth`
supplies. `tests/integration/k015-ap-migration-balance-due-column.int.test.ts` (4) and
`tests/integration/k089-ar-migration-balance-due-column.int.test.ts` (4) — 8 passed. Each file
covers: import with `amountPaid` > 0 (amount_paid preserved, balance derived, balanced journal
agreeing with the invoice), a mid-batch failing row, same-name contact in a second tenant, and an
unmatched contact. Mutation checks for all five production edits in `green.log`.

**Migration / rollback.** None. Revert the two files to roll back.

**Historical data.** No stored rows can be wrong — no INSERT ever succeeded. The impact is
absence. Read-only check for tenants whose wizard run died:
```sql
SELECT company_id, id, ap_invoices_imported, ar_invoices_imported, errors
  FROM migration_sessions
 WHERE errors::TEXT LIKE '%balance_due%' OR errors::TEXT LIKE '%"reference"%';
```

**Limits.** Proven at the service layer inside a withAuth-shaped transaction, not through an HTTP
request with a live GoTrue session. R-001 and R-002 both still reproduce — see below; not fixed here.

## R-001 / R-002 on the fixed path (measured, not fixed)

**R-001 — reproduces.** Importing a fully paid bill (total 115, amountPaid 115) stores
`amount_paid` 115, `balance` 0, `status` 'paid', and posts exactly one journal: DR expense 100 +
DR VAT 15 / CR payable 115. Measured: payable control net credit 115.00, journal entries 1,
bank/cash lines 0. The subledger says nothing is owed while the AP control account still carries
the full 115, and no settlement journal or bank leg exists.

**R-002 — reproduces.** subtotal 33.33 + tax 5.00 against total 38.34 makes the journal
DR 38.33 / CR 38.34. `postJournalEntry` rejects it: "Entry is not balanced: total debit R38.33 !=
total credit R38.34 (difference: R0.01)". Result `{imported: 0, skipped: 1}`, 0 invoice rows. The
savepoint now contains it — the run no longer 500s — but the row is dropped with only an error
entry, so a rounding difference in the source file silently loses the document.

---

# Follow-up: blind-review remediation (all 11 findings)

Full detail in `review-response.md` next to this file. Summary of the behaviour changes:

- **Settlement leg (H1).** An already-paid amount now posts a second balanced journal against
  opening balance equity, so the AP/AR control account carries the OUTSTANDING balance and agrees
  with the invoice's own `balance`. This supersedes R-001 below: it no longer reproduces.
- **Duplicate guard (H2).** Migration `625_supplier_invoice_duplicate_fingerprint_unique.sql` makes
  `supplier_invoices.duplicate_fingerprint` unique per company, which is what
  `ON CONFLICT DO NOTHING` had always assumed. **Apply 625 before shipping this code** — without
  the index the INSERT cannot infer its arbiter and every row fails.
- **Session bookkeeping (M1, M2).** `updateSession` merges `steps_completed` and appends `errors`
  rather than replacing both, so one step no longer erases the record of the steps before it.
- **Reasons on skips (M3), amount check (M4), source system (M5), optional amountPaid (L3).**
- **Request validation (L2)** via `src/modules/accounting/services/core/migrationRowSchemas.ts`.

R-002 no longer surfaces as a raw posting failure: the row is rejected up front with a message
naming subtotal, tax and total. It still means the document is not imported — folding a cent into
a rounding line would need a designated rounding account, which is Hein's call.

Two things stay open by choice, both in `review-response.md`: the opening-balances step and the
invoice import still double the control accounts, and `customer_invoices.external_ref` has no
reader.

---

# Follow-up 2: second blind review (N1-N6)

Full detail in `review-response-2.md`.

- **Migration 625 is now keyed on `(company_id, supplier_id, duplicate_fingerprint)`.** Keying it
  on company and fingerprint alone made two different VAT-less suppliers collide, because
  `computeFingerprint` folds a missing VAT number to the literal `no-vat`. It also hard-constrained
  five unrelated AP write paths. `createSupplierInvoice` now reports that 23505 by name.
- **Missing-migration guard.** The AP import aborts on `42P10` with a message naming migration
  625, instead of answering 200 with `imported: 0` and a raw Postgres message on every row.
- **The clearing account is resolved once per step**, and only when some row is part-paid, so a
  company without one fails once with a clear message and can still import unpaid invoices.
- **`errors` supersedes the step's own entries** rather than appending, so a re-run does not
  report the same row twice or grow the column without bound.

## Before deploying

1. **Run this against production first.** It was NOT run from this session, which is barred from
   the production database. Rows mean migration 625 aborts the deploy before the rsync.
   ```sql
   SELECT company_id, supplier_id, duplicate_fingerprint, COUNT(*)
     FROM supplier_invoices
    WHERE duplicate_fingerprint IS NOT NULL AND deleted_at IS NULL
    GROUP BY 1, 2, 3
   HAVING COUNT(*) > 1;
   ```
2. **Apply 625 before this code ships.** Without the index the AP step aborts with a named error.
3. **Out of hours on a large tenant.** `CREATE UNIQUE INDEX` cannot run `CONCURRENTLY` inside a
   migration transaction, so it blocks writes to `supplier_invoices` while it builds.

`idx_supplier_invoices_duplicate_fp` (migration 412) is deliberately kept: `findDuplicate`'s probe
has no `deleted_at` predicate, so it cannot use an index partial on `deleted_at IS NULL`.

---

# Follow-up 3: migration 625 withdrawn as a unique index

A production pre-flight probe (run by the team lead, not from this session) found groups of 55-79
live supplier invoices sharing one `duplicate_fingerprint`. The unique index could not be built.
625 is now a NON-UNIQUE lookup index matching how `findDuplicate` probes, the wizard's idempotency
is an explicit lookup before the INSERT instead of `ON CONFLICT`, and everything that depended on
the unique violation is deleted rather than left as dead code. Detail in `review-response-5.md`.

**The deploy notes from follow-up 2 no longer apply.** There is no pre-flight duplicate query to
run, and no unique-index build lock: 625 is a plain `CREATE INDEX IF NOT EXISTS`. It should still
be applied before this code ships, so the lookup it serves is indexed, but the import no longer
fails without it.

## Register item: `duplicate_fingerprint` is not a per-document key

`lower(vat_number|invoice_number|total_amount)` with `no-vat`, `no-inv` and `0` substituted for
missing parts, in both producers (migration 412's backfill and `computeFingerprint`). Every row
missing the same parts collapses onto one string, which is what the production groups are. Whether
it should discriminate per document — by adding the invoice date or the source document id — is a
decision affecting every duplicate check in the system and all the data already stored. Not
changed here.

---

# Follow-up 4: take-on posting closes R-001, R-002 and R-020 — WIZARD PATH ONLY

Per the independent design memo. An imported document is a take-on, not an origination: one entry
of two lines at `total - amountPaid` against `opening_balance_equity`, with **no revenue, expense
or VAT line**. A document settled in full before the cutover posts nothing and keeps its
`amount_paid`. Full record in `takeon-posting.md`.

- **R-001 closed for the wizard.** The control account equals the subledger by construction; both
  close-readiness sub-ledger checks pass after an import, and no VAT is re-declared.
- **R-002 closed.** Up to R0.05 of drift imports with a warning; beyond that the row is refused
  naming all three amounts.
- **R-020 closed.** A trial balance carrying a receivable or payable control line is refused, and a
  non-zero clearing residual is recorded on the session at `completeSession`.

**The Sage commit path is NOT changed and is a separate follow-up.**
`sageMigrationCommitService` still posts the full invoice with its VAT line, so R-001 and the VAT
re-declaration remain open there.

**Forward-only — measured, not assumed.** The team lead ran the read-only probe against production
on 2026-09-09: 0 customer invoices and 0 supplier invoices with `amount_paid > 0` carrying an
`auto_migration` journal. Nothing was posted under the old shape, so there is no repair migration,
no reversing journals and no VAT201 restatement. Detail and the query in `takeon-posting.md`.
