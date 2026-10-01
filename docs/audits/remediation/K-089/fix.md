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

---

## Round 4 — dispositions for the round-3 blind review (11 findings)

K-089 is the AR half of the same branch. The findings below are shared; the AR-specific ones are
HIGH-1 (the AR schema deliberately keeps `min(1)`), M-B, M-C and the L-1/L-3 file splits.

**HIGH-1 — the schema forbade the blank invoice number the fallback exists for. FIXED, by making
the schema agree with the design, not by deleting the fallback.** Blank supplier invoice numbers
are legitimate: migration 412's fingerprint substitutes `no-inv` for exactly that case, K-107's
`uq_supplier_invoices_supplier_number` exempts `invoice_number = ''`, and a take-on file of till
slips and cash purchases carries them. So `APInvoiceRowSchema.invoiceNumber` is now
`z.string().trim().max(100)` — the fingerprint fallback and migration 625 are on the live path —
while `ARInvoiceRowSchema` still requires a number, because `uq_customer_invoices_company_number`
is company-wide with no blank exemption and a second blank AR number cannot be inserted at all.
And a bad row no longer costs the file: see M-C.

**M-A — `DROP INDEX` took ACCESS EXCLUSIVE on a table 18 other test files read. FIXED.** The test
now creates a per-run schema holding `supplier_invoices (LIKE public.supplier_invoices INCLUDING
ALL)` with the borrowed unique index dropped **from the copy**, and each test that needs
production's shape sets `SET LOCAL search_path` to it — transaction-scoped, so it unwinds with the
ROLLBACK, and it locks nothing anyone else touches. The property the reviewer asked to keep is
kept and asserted: the test proves the table it writes to carries no unique index on
`(company_id, supplier_id, invoice_number)` before it runs. Proof it no longer blocks: 40
consecutive `SET lock_timeout='3s'; SELECT count(*) FROM public.supplier_invoices` probes ran
against the shared fixture for the whole duration of the suite, zero cancellations (green.log).

**M-B — `assertNoOpeningControlTotal` was a one-way door whose remedy double-posted. FIXED.**
`importOpeningBalances` now (a) rewrites BOTH control flags from each run's own trial balance,
including `false`, so re-running without the control line clears the refusal, and (b) reverses the
entry its previous run posted for this session (`reverseJournalEntry`, scoped by
`created_at >= migration_sessions.started_at`) before posting the new one, so following the
instruction replaces the trial balance instead of stacking a second one on it.

**M-C — one malformed row rejected the whole file with no row index. FIXED.** The routes parse the
envelope only; `parseInvoiceRows` then parses each row and returns the good rows, their positions,
and one error per bad row naming the field and the row. The services take an `ImportRowContext`, so
every `row` they report — and every row they persist to the session — is a position in the
operator's file, not in the shortened array.

**M-D — soft-delete then re-import doubled the AP control. FIXED.** The idempotency lookup no
longer carries `deleted_at IS NULL`. Soft-deleting a migrated bill leaves its take-on entry posted,
so the money is still in the control account; the re-import is refused with a message that says so
and names the remedy (reverse the entry first). This also removes the AR/AP asymmetry that was
**L-5**.

**M-E — the key was case-sensitive where the fingerprint was not. FIXED.** The lookup compares
`LOWER(invoice_number)` on both sides.

**L-1 / L-3 adjudication — the file-size measurements were right and the deferral is withdrawn.
FIXED.** `sageImportService.ts` 539 → **281** (`importSupplierInvoices` and its two JSON helpers
moved to `sageSupplierInvoiceImportService.ts`, 217; the relink decision moved to
`sageLedgerRelinkGuard.ts`, 91 — logic unchanged, comments carried with it). `migrationImportService.ts`
301 → **199** (`importOpeningBalances` moved to `migrationWizardOpeningBalanceService.ts`, 180).
Both original modules re-export what they used to own, so no caller changed.

**L-2 — fingerprint scale. UPHELD, no action.** Adjudicated final by the team lead.

**L-3 (stale docstring) — FIXED.** `rethrowIfConflictTargetMissing` now says AR is the only
`ON CONFLICT` caller.

**L-4 — the AP page's supplier override was discarded. FIXED.** `supplierId` is on
`APInvoiceRowSchema` and honoured by `importAPInvoices`, but only after being resolved against the
importing company's own suppliers; an id from another tenant is refused with `field: 'supplierId'`.

**L-5 — AR/AP asymmetry on soft-deleted documents. FIXED** as a consequence of M-D.

**Migration.** None added this round. 625 is unchanged and is now genuinely reachable.

**Historical data.** Unchanged from round 3 — the AP wizard imported nothing before this branch.
The M-D impact query, for any tenant that re-imported over a soft-deleted migrated bill:
```sql
SELECT si.company_id, si.supplier_id, si.invoice_number, COUNT(*) AS rows,
       SUM(je.total_debit) AS taken_on
  FROM supplier_invoices si
  JOIN gl_journal_entries je ON je.id = si.gl_journal_entry_id AND je.company_id = si.company_id
 WHERE je.source = 'auto_migration' AND je.reversed_at IS NULL
 GROUP BY 1, 2, 3
HAVING COUNT(*) > 1 AND COUNT(*) FILTER (WHERE si.deleted_at IS NOT NULL) > 0;
```

**Limits.** Unchanged: the wizard pages are proven at the component level, not by a browser load.
The soft-delete defect in `softDeleteService` (its reversal guard only fires on `status = 'posted'`,
which a migrated bill never is) is NOT fixed here — this branch stops the wizard doubling the
control account, it does not make soft-delete reverse a take-on. Register item.
