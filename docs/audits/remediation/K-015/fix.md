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

# Follow-up 5: third blind review (`review-k015b.md`) — all 8 findings

No finding disputed. Files: the four migration services, the two wizard pages, a new
`src/components/accounting/migration/InvoiceImportResult.tsx`, both module `.claude.md` +
mirrors, `takeon-posting.md`, plus tests. Evidence and per-mutation output in `green.log`
("Round 3"). Integration 42 passed (was 38); components 4 passed; full unit suite 9426 passed
with the fixture env unset; `tsc`, `eslint`, `agent-docs:check` clean. No migration.

- **M1 — the concurrency claim was wrong. FIXED.** `uq_supplier_invoices_supplier_number` is in
  the shared fixture DB only: it is K-107's migration 646, on an unmerged local branch and on no
  origin ref (checked over `refs/remotes/origin` and every local branch). It is not in production,
  so "AP has no unique constraint" was true of production and false of the fixture — the doc and
  the code comment now say exactly that. The test asserts what only the lock produces: one
  document, one entry, and a skip reported as `Already imported` with no `duplicate key` text.
  Mutation M-A takes it red in both worlds.
- **M2 — the residual accused a correct conversion. FIXED.** `recordClearingResidual` is now
  `severity: 'warning'` and its message says a residual is *expected* when the whole trial balance
  was balanced on Opening Balance Equity, before offering the double-count reading. The
  assumption is stated in the function's own doc comment. Not made enforceable: which convention
  the operator used is not knowable from the ledger.
- **M3 — R-020 blocked summary-only migrations. FIXED.** A trial balance may carry an AR or AP
  control total *instead of* the documents. `importOpeningBalances` accepts the control line when
  the matching document step has not run and records it in `steps_completed`
  (`opening_balances_ar_control` / `_ap_control`); `assertNoOpeningControlTotal` then refuses that
  document step. Either order is blocked, one side at a time. Mutations M-B and M-C.
- **M4 — the warning reached nobody. FIXED.** Warnings are persisted on the session alongside the
  errors, marked `severity: 'warning'`, so they survive a reload. Both wizard pages render the new
  `InvoiceImportResult`, which shows `imported` / `skipped` (the fields the service actually
  returns — both pages printed `undefined` for `succeeded`/`failed`, a pre-existing defect fixed
  here) plus every warning and error. Mutations M-E and M-F.
- **L1 — every take-on file now needs `opening_balance_equity`. ACCEPTED, not changed.** The
  reviewer recorded it as an accepted operational regression; it follows from the design memo, the
  refusal is up front with the role named, and no partial writes occur. Tenants missing the role
  must add it before the wizard's document steps — an onboarding step, not a code defect.
- **L2 — module docs silent on the new rule. FIXED.** `core/.claude.md` and `ap/.claude.md` (and
  their AGENTS.md mirrors) now carry a 2026-09-09 entry stating the take-on shape, the 5c
  tolerance, the control-total interlock and the residual's assumption.
- **L3 — the residual was company-wide. FIXED.** The query joins `migration_sessions` and counts
  only entries posted at or after that session's `started_at`. Mutation M-D.
- **L4 — a test title contradicted its assertion. FIXED.** The consistent-conversion test now
  removes the control lines from the trial balance, as the procedure prescribes, and asserts the
  clearing account nets to **zero** (the memo's test 6). The balanced-on-equity convention gets
  its own test asserting the warning's wording.

**Historical data.** Unchanged from follow-up 4: forward-only, nothing to repair. The R-020
change only widens what the wizard accepts, and the residual is recorded, never enforced.

---

# Follow-up 6: fourth blind review (`review-k015b-r2.md`) — 2 HIGH, 3 MEDIUM, 4 LOW

Integration 48 passed (was 42); components 419 passed across 63 files (2 new files, 3 new tests);
full unit suite 9426 passed with the fixture env unset; `tsc`, `eslint` (src/pages), and
`agent-docs:check` clean. Five mutations, one per production edit, each red on the test that owns
it — recorded in `green.log` ("Round 4"). No migration.

- **H1 — the AP wizard page could never reach the import. FIXED.** `ap-invoices.tsx` read
  `sessionJson.data?.id` while the route answers `apiResponse.success(res, { session })`, so
  `data.id` was always `undefined` and every Import click threw "No active migration session"
  before POSTing — making follow-up 5's `InvoiceImportResult` banner unreachable on that page, and
  its commit message's "both wizard pages" claim false for AP. It now uses the typed
  `apiJson('/api/accounting/migration/session')` the AR page uses. Proved by rendering the page
  itself over the real response envelope (`tests/unit/components/apInvoicesWizardPage.test.tsx`):
  the mutation back to `data?.id` fails with the exact "No active migration session" text.
- **H2 — a re-run with a corrected total posted the bill twice. FIXED.** AP idempotency keyed on
  `computeFingerprint(vat, invoiceNumber, totalAmount)`, and the total is part of that key, so the
  ordinary operator loop (import, spot a wrong total, correct the CSV, re-run) missed the lookup
  and minted a second `supplier_invoices` row and a second posted take-on journal against the AP
  control account. The key is now the bill's IDENTITY — `(company_id, supplier_id, invoice_number)`
  where the number is non-blank, `deleted_at IS NULL` — with the fingerprint kept as the fallback
  for a blank-numbered row, which has no identity to key on. No migration: a unique index is
  impossible here (blank invoice numbers legitimately repeat, and 625's unique form was withdrawn
  at `209f9761` over the production groups of 55-79 degenerate fingerprints, R-025). The lookup is
  serialised by the existing `lockMigrationImport`, exactly as the fingerprint lookup was.
  **Tested against production's shape, not the fixture's:** the fixture DB carries
  `uq_supplier_invoices_supplier_number` (K-107's migration 646, on no origin ref, R-036), which
  would raise 23505 and mask the defect entirely, so the three new AP tests
  `DROP INDEX IF EXISTS uq_supplier_invoices_supplier_number` inside their own transaction — DDL is
  transactional in Postgres, so the `ROLLBACK` in `finally` restores it and no other session's
  fixture is affected. The test asserts the index is gone before importing.
- **M1 — `importOpeningBalances` took no lock. FIXED.** It now takes `lockMigrationImport` before
  reading the session, as both document steps do. Without it an overlapping pair — opening balances
  carrying a control line, and the matching document step — each read a `steps_completed` map
  without the other's mark, both passed, and both posted. Proved with two interleaved pool clients.
- **M2 — the flag recorded "the step ran", not "documents were taken on". FIXED.** The refusal in
  `importOpeningBalances` is now gated on `{ar,ap}_invoices_imported > 0` rather than on
  `steps_completed`, which is written even by a run that imported nothing. An operator whose first
  AP file matched no supplier could otherwise never bring the AP control total in for that session.
  The step flag itself is unchanged — the hub's progress display and the error-supersede logic both
  depend on it meaning "the step ran".
- **M3 — the persisted warnings were read by nobody. FIXED.** The migration hub now renders them:
  `src/components/accounting/migration/SessionIssues.tsx`, mounted on
  `pages/accounting/migration/index.tsx`. Warnings first, then errors, each labelled with its step
  and one-based row. This is the honest closure of follow-up 5's M4 and makes the durability claim
  in both `.claude.md` files true rather than aspirational.
- **L1 — the residual and the resolver disagreed. FIXED.** `recordClearingResidual` now applies the
  same `is_system_account = true AND is_active = true` predicates `getSystemAccountId` resolves the
  clearing account by, so a second, non-system Opening Balance Equity account on the chart no longer
  pulls lines the take-on never posted to into the residual.
- **L2 — `computeFingerprint` scale vs migration 412's backfill. DISPUTED, registered.** The
  mismatch is real (`1150` vs `1150.00`) and pre-dates this branch in the capture path. It is NOT
  fixed here: `computeFingerprint` feeds four services (`captureDeduplicationService`,
  `supplierInvoiceService`, `sageImportService`, `recurringTransactionService`) and every
  `duplicate_fingerprint` already stored by application code; changing its scale invalidates that
  whole corpus and needs a re-backfill, which is a data migration in its own right. H2 also removes
  the wizard's dependence on it for any numbered bill. Register item, unchanged from follow-up 3's.
- **L3 — `sageImportService.ts` is 539 lines. DISPUTED, registered.** Pre-existing: 526 lines at
  the merge base, grown by the 13 lines of savepoint wrapper this branch's fix required. Splitting
  it cannot reach the 300-line ceiling without also breaking up `importLedgerTransactions`, a
  289-line function this branch does not otherwise touch — an adjacent refactor of a ledger-posting
  path, in a fix PR, which the fixer brief forbids and the reviewer himself judged would widen the
  diff. Recorded rather than done.
- **L4 — the PR head is behind the local branch. NOT FIXABLE FROM HERE.** `origin/...` still carries
  `625_supplier_invoice_duplicate_fingerprint_unique.sql`, the withdrawn UNIQUE index that aborts
  the deploy on real data. This session is barred from pushing. **The branch must be pushed before
  PR #373 is read or merged.** Escalated to the team lead.

**Historical data.** Still forward-only; nothing stored can be wrong under H2, because before this
branch the AP wizard imported nothing at all (the `balance_due` defect). Read-only check for any
tenant that ran a corrected re-run against a build carrying the fingerprint key:
```sql
SELECT company_id, supplier_id, invoice_number, COUNT(*), SUM(total_amount)
  FROM supplier_invoices
 WHERE deleted_at IS NULL AND invoice_number <> ''
   AND gl_journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE source = 'auto_migration')
 GROUP BY 1, 2, 3
HAVING COUNT(*) > 1;
```

**Limits.** The wizard pages are proven by rendering the real page components over the real
response envelopes, not by a browser load against a running dev server — no dev server was
available in this worktree. That crosses the envelope → page state → banner seam H1 lived in, but
not CSS, layout, or the live auth/company header path.

---

## Round 4 — dispositions for the round-3 blind review (11 findings)

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

---

## Round 5 — the blind review of `242bf867f` (9 findings)

**H-1 — the blank-number fallback collapsed distinct bills, and an unmapped column imported a
fraction of the file silently. FIXED, both halves.**
*Blank rows:* the fallback keyed on `duplicate_fingerprint` — `lower(vat|number|total)`, with no
date — so two till slips from one supplier for the same round amount on different days were one
key, and the second was reported "already imported" and dropped. The blank branch now keys on the
identity such a bill actually has: `COALESCE(invoice_number,'') = ''` AND `invoice_date` AND
`total_amount` AND `COALESCE(reference,'')`. A genuine repeat is still refused.
*Unmapped column:* `pages/accounting/migration/ap-invoices.tsx` sent `?? ''`, so an unmapped column
was indistinguishable from a file of unnumbered bills. It now sends the field only when the column
is mapped (JSON.stringify drops `undefined`), and the route refuses the WHOLE file with a 400 that
names the mapping mistake when NO row carries the field (`invoiceNumberColumnUnmapped`). A file that
legitimately contains blanks sends `''` and still imports.

**H-2 — the two fingerprint producers disagreed. FIXED, and it needs a re-backfill.**
The column is `NUMERIC(15,2)`, so SQL renders 115 as `115.00`; `computeFingerprint` rendered the JS
number as `115`. Migration 412 backfilled every pre-412 row in the SQL format, so no lookup from the
application could match one: the duplicate was created again and posted again. `computeFingerprint`
is the single TS producer and now formats the amount `.toFixed(2)`; **migration 670 rewrites every
stored `duplicate_fingerprint` into that same shape** (idempotent, re-runnable). The agreement is
proved against the real database over six (vat, number, amount) shapes, and 670's statement is
executed in the test over a row stamped in the old TS format.

**M-1 — `INCLUDING ALL` did not reproduce production's shape. FIXED, partially and explicitly.**
The per-run copy now replays production's RLS (`ENABLE` + `FORCE`) and its policy and trigger, and
`beforeAll` asserts all three. The four FOREIGN KEYs are deliberately NOT replayed and the comment
says so: `ADD CONSTRAINT … FOREIGN KEY` takes SHARE ROW EXCLUSIVE on the REFERENCED table, and
measured on the fixture it blocks behind other agents' work on `companies` — the shared-lock failure
that took eighteen files down last round.

**M-2 — `purgeExpiredDeletes` defeated the guard five minutes later. FIXED.** Both invoice sweeps
now carry `AND gl_journal_entry_id IS NULL`, so a document whose journal is still in the GL is never
hard-deleted. Proved by running the real function against copies of all six swept tables.

**M-3 — the schema comment's evidence was wrong. FIXED.** The migration-412 `no-inv` claim is gone
(the column is `VARCHAR(50) NOT NULL`, so that COALESCE cannot fire) and the comment now cites what
is true: no unique index on the number exists, and K-107's proposed 646 exempts `''`.

**L-1 — zod caps exceeded the columns. FIXED.** `invoiceNumber` is `max(50)` on both schemas.
**L-2 — the per-run schema leaked on a failed cleanup. FIXED.** `DROP SCHEMA` is in a `finally`.
**L-3 — the 5000-row cap had no message. FIXED.** It now says to split the file.
**L-4 — the comment asserted an index that may merge. FIXED.** It cross-references 646 and says what
changes if it lands.

**Migration.** `670_supplier_invoice_fingerprint_canonical_backfill.sql` — one UPDATE, idempotent,
applied to the fixture DB. Rollback: none needed; re-running is a no-op. **Not** rerunnable-safe to
skip: without it, the app's new fingerprints and the stored ones disagree on post-412 rows.

**Historical data.** Every `supplier_invoices.duplicate_fingerprint` in production is in one of the
two formats; 670 normalises all of them. Rows whose duplicate went undetected because of the split
(a bill created twice through capture, recurring or the wizard) are found with:
```sql
SELECT si.company_id, si.supplier_id, si.invoice_number, si.total_amount, COUNT(*) AS rows
  FROM supplier_invoices si
 WHERE si.deleted_at IS NULL
 GROUP BY 1, 2, 3, 4
HAVING COUNT(*) > 1;
```

**Limits.** Still no browser load of the wizard (component-level proof only). The route's whole-file
refusal is proved at the helper and the page, not through an HTTP request. The `softDeleteService`
non-reversal of a take-on remains a register item, not fixed here.

---

## Round 6 — the blind review of `78fa01e21` (5 findings)

**H-1 — a THIRD fingerprint producer, disagreeing with the canonical form. FIXED.**
`pages/api/accounting/capture/[id]/post.ts` built the value inline in its INSERT, casting the JS
total bound as a parameter to text: it wrote `…|115` where the column, `computeFingerprint` and
migration 670 all write `…|115.00`. Every bill captured through that route stored a key
`findDuplicate`'s exact-match step could never produce, so the same bill could be posted again with
a second accrual against the payable control account — the defect this branch exists to close, on
the capture path, re-accumulating from the first capture after 670 ran. The route now calls
`computeFingerprint` and binds one parameter.

**Why rounds 1–5 missed it.** The census looked for CALLERS of `computeFingerprint`. That can only
find code already using the helper; it cannot find code that builds the value itself. Enumerated
from the DATA this round — every write to `duplicate_fingerprint` in `src/`, `pages/`, `scripts/`:

| # | Site | Produces | Verdict |
|---|------|----------|---------|
| 1 | `pages/api/accounting/capture/[id]/post.ts:138` | inline SQL concatenating the coalesced parts, with `$n::text` for the total | **WAS WRONG — now `computeFingerprint`** |
| 2 | `pages/api/accounting/ai-invoice-pipeline.ts:138` | `computeFingerprint` | canonical |
| 3 | `src/modules/accounting/services/ap/supplierInvoiceService.ts:129` | `computeFingerprint` | canonical (the MCP tools and `writeBulkInvoices` reach the column only through here) |
| 4 | `src/modules/accounting/services/ap/migrationApService.ts:202` | `computeFingerprint` | canonical |
| 5 | `src/modules/accounting/services/core/recurringTransactionService.ts:220` | `computeFingerprint` | canonical |
| 6 | `src/modules/accounting/services/core/sageSupplierInvoiceImportService.ts:100` | `computeFingerprint` | canonical |
| 7 | `scripts/migrations/sql/412_supplier_coding_rules.sql:71` | SQL, `total_amount::text` | historical; 670 rewrites what it wrote |
| 8 | `scripts/migrations/sql/670_…_canonical_backfill.sql:29` | SQL, `::NUMERIC(15,2)::TEXT` | the canonical rendering |
Every other `INSERT INTO supplier_invoices` (`bank-match-confirm`, `supplier-merge`, the seed and
Sage scripts, `sageMigrationCommitService`) omits the column entirely and leaves it NULL; 670's
predicate is `IS DISTINCT FROM`, so those rows are canonicalised too rather than skipped.
`bulkInvoiceDuplicateSkip.ts`'s local `fingerprint()` is an in-memory batch key that never reaches
the column. Rows this third producer wrote BEFORE the backfill are ordinary non-canonical rows and
670 rewrites them like any other — proved by the test that stamps the old TS format and runs the
migration.

**M-1 — 670 skipped a cross-tenant row and still reported success. FIXED.** The only FK on
`supplier_id` is to `suppliers(id)`; nothing enforces `s.company_id = si.company_id`, so a row whose
supplier is in another tenant was unreachable by the company-scoped UPDATE and kept a stale
fingerprint silently. A `DO $$ … RAISE EXCEPTION` pre-check now names those ids and refuses; there
is no correct company to read the VAT number from, so canonicalising them is not the migration's
call. **Run before deploying 670** (read-only): `SELECT si.id, si.company_id, s.company_id FROM
supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id WHERE s.company_id <> si.company_id;`
— if it returns rows, 670 will refuse until they are re-parented.

**L-1 — `toFixed(2)` and `NUMERIC(15,2)` round `.xx5` in opposite directions. FIXED.**
`(1.005).toFixed(2)` is `"1.00"`; `'1.005'::numeric(15,2)` is `1.01`. `computeFingerprint` now
rounds the driver's decimal text half away from zero (`toColumnScale`), so the fingerprint matches
the stored amount for every input, not merely for the exact ones. Proved against the real column.

**L-2 — the refusal message misdescribed the blank-number case. FIXED.** A numbered row keeps
"Correcting an imported bill is an edit, not a re-import."; a blank-numbered one now says the two
bills cannot be told apart and that a number or reference imports the second.

**L-3 — `purgeExpiredDeletes` swept every tenant. FIXED.** It takes `companyId` and every one of the
six DELETEs carries `company_id = ${companyId}::uuid`. It stays UNCALLED in production; the
signature is what a future scheduled job has to satisfy, one tenant at a time.

**Round-6 tests.** `tests/unit/services/capturePostFingerprint.test.ts` (2, new — pins the route's
own INSERT, not the helper), `duplicateDetectionService.test.ts` +1 rounding case,
`k015-ap-migration-balance-due-column.int.test.ts` +1 (670 refuses and names the row) plus the
cross-tenant purge survivor and the two message assertions. Mutation-proved: restoring the inline
SQL, `toFixed`, the DO block's removal, the unscoped DELETEs and the old message each turn the
matching test RED.

---

## Round 7 — the blind review's four findings

**HIGH-1 — same function, different argument: the VAT segment had two sources. FIXED.**
Round 6 unified the FUNCTION and stopped there. `post.ts` called `computeFingerprint`, but fed it
`extracted.vendorVatNumber` — the number OCR'd off the document — while the other seven producers
and migration 670 read `suppliers.vat_number`. Running 670 therefore rewrote every capture-written
row to the supplier-record VAT, which is not what the next capture of that bill computes: exact-match
hits dropped to zero and the bill was accrued a second time. The route now takes `vat_number` from
the company-scoped supplier row it already loads, and passes that same value to `decide(...)` and to
`computeFingerprint`.

*Which source is authoritative, and why.* `suppliers.vat_number`. Not because seven producers
outvote one: the supplier record is the identity the invoice is actually booked against and is
under the tenant's control, whereas `extracted.vendorVatNumber` is a per-scan OCR reading that
varies with image quality and is absent whenever the document does not print a VAT number — two
captures of the same bill can disagree, which is fatal for a dedupe key. A capture always has a
linked supplier here (the route returns `manual_review` before this point when
`matchSupplierFromExtraction` finds none), and a supplier with no VAT number folds to the literal
`no-vat`, exactly as 670's `coalesce(s.vat_number, 'no-vat')` does.

**Census re-run by ARGUMENT, not by callee.** For each producer, where each segment's value comes
from:

| # | Site | VAT segment | Invoice-number segment | Amount segment |
|---|------|-------------|------------------------|----------------|
| 1 | `pages/api/accounting/capture/[id]/post.ts` | `suppliers.vat_number` (company-scoped `SELECT` at :86) — **was `extracted.vendorVatNumber`** | `buildInvoiceFromExtraction(...).invoiceNumber` | same, `.totalAmount` |
| 2 | `pages/api/accounting/ai-invoice-pipeline.ts:94-100` | `SELECT vat_number FROM suppliers WHERE id AND company_id` | `invoiceInput.invoiceNumber` | `invoiceInput.totalAmount` |
| 3 | `services/ap/supplierInvoiceService.ts:114-119` | same `SELECT` | `input.invoiceNumber` | computed `totalAmount` |
| 4 | `services/ap/migrationApService.ts:67,119` | `vat_number` from the company-scoped supplier list | `inv.invoiceNumber` (CSV row) | `inv.totalAmount` |
| 5 | `services/core/recurringTransactionService.ts:205-214` | same `SELECT`; `null` when the template has no supplier | generated `RSINV-<slug>-<period>` | `Number(data.totalAmount)` |
| 6 | `services/core/sageSupplierInvoiceImportService.ts:84-92` | same `SELECT` | `inv.invoice_number` or `SAGE-<id>` | computed `totalAmount` |
| 7 | `scripts/migrations/sql/412_supplier_coding_rules.sql:71` | `coalesce(s.vat_number,'no-vat')` | `coalesce(si.invoice_number,'no-inv')` | `total_amount::text` (superseded) |
| 8 | `scripts/migrations/sql/670_…:56` | `coalesce(s.vat_number,'no-vat')` | `coalesce(si.invoice_number,'no-inv')` | `::NUMERIC(15,2)::TEXT` |

All eight now agree on every segment. The lesson recorded for the next census: checking that a
producer CALLS the shared helper proves nothing about what it PASSES.

**670 convergence, proved.** `k015-…int.test.ts` stamps two rows — one keyed the way the fixed route
keys it (supplier VAT), one the way the old route did (document VAT) — runs 670 verbatim, then runs
`findDuplicate`'s step-1 predicate. The supplier-VAT row is untouched by 670 and found (1 hit); the
document-VAT key finds 0. Mutation-proved: replacing 670's `coalesce(s.vat_number,'no-vat')` with a
literal turns it RED.

**LOW-1 — `-0.00`. FIXED.** `toColumnScale` prepended the sign unconditionally, so `-0.001` rendered
`-0.00` where `NUMERIC(15,2)` renders `0.00` (NUMERIC has no signed zero). `total_amount` carries no
non-negative CHECK, so negative bills are storable and such a row's fingerprint was one the column
could never reproduce. The sign is now dropped when the rounded magnitude is zero, on both the
decimal and the exponential branch. `-0.005` still renders `-0.01`, as the column does.

**LOW-2 — unbounded `string_agg` in 670's refusal. FIXED.** The pre-check now counts the offending
rows and names at most 20: `… cannot be canonicalised: N row(s), first up to 20: <ids>`. The count is
the real total, not the sample size.

**LOW-3 — out-of-band inserts keep a NULL fingerprint. DOCUMENTED, no code change.**
`scripts/import-sage-britech.ts`, `scripts/qa-seed/transactions.ts` and
`scripts/seed-historical-data.mjs` omit the column; 670 canonicalises the NULLs present when it runs,
but rows these write afterwards stay NULL and are invisible to the exact-match step (the fuzzy step
still covers them). Pre-existing, confined to import/seed tooling, out of this branch's scope —
recorded as a business rule in `src/modules/accounting/services/capture/.claude.md` together with the
one-source-per-segment rule, so the next author of a producer reads it.

**Round-7 tests.** `tests/unit/services/capturePostFingerprint.test.ts` 2 → 5 (supplier-row VAT wins
over the OCR value; `no-vat` when the supplier has none even though the document does; the gate and
the INSERT get the same string). `duplicateDetectionService.test.ts` +1 (signed-zero cases, both
branches). `k015-ap-migration-balance-due-column.int.test.ts` +1 (670 convergence, real DB). Unit
27 passed for the two files; integration file 25 passed; full unit suite with `DATABASE_URL` unset:
793 files, 9443 passed / 234 skipped, 0 failed. `tsc --noEmit` clean; `eslint` on both changed
source files clean. No migration added (670 is unmerged and fixture-only, so it was edited in
place). No historical-data impact beyond what 670 already performs.

---

## Round 8 — the closing blind review (0 HIGH, 0 MEDIUM, 2 LOW; branch marked DONE)

**Provenance note.** The host rebooted mid-round and cleared `/tmp`, taking `review-k015b-r8.md`
with it. The two LOW texts are therefore RECONSTRUCTED from the in-flight diff left on disk, not
quoted. Both reconstructions are stated below with the evidence that identifies them; a fresh
review will re-find anything this misreads.

**LOW-1 — the two sides folded case by different rules. FIXED.** `computeFingerprint` folded with
`toLowerCase()` and migration 670 with `lower()`, and the two are not the same mapping. `lower()`
is collation-driven; JS is not. In an `en_US.utf8` database `lower('İNV-1')` is `inv-1` while
`'İNV-1'.toLowerCase()` is a SIX-character `i̇nv-1` (it appends U+0307), and `lower('ΣΟΣ')` is
`σοσ` while JS gives `σος` (final sigma). `invoice_number` is free text off a CSV or an OCR read
and both characters are storable in it, so one such bill got a stored key the lookup could never
reproduce — this branch's own defect, one character class over. Both sides now fold **A–Z and
nothing else**: `asciiLower()` in `captureDeduplicationService.ts`, and `translate(…, 'A-Z',
'a-z')` in 670, which takes no collation input. A–Z is the only range SA VAT numbers, bill numbers
and the fixed-2 amount ever occupy, so nothing that should fold stops folding.

**LOW-2 — "all eight producers agree" was false of migration 412. FIXED (documentation).** Round 7's
census closed with that sentence. 412's backfill agrees on the amount segment only by accident —
`coalesce(total_amount::text, '0')` renders a NULL as `0`, not `0.00`, and matches the other seven
only because `total_amount` is `NOT NULL DEFAULT 0` — and after LOW-1 it also disagrees on the
fold. It is a HISTORICAL producer, superseded by 670 on every row, and 670's `IS DISTINCT FROM`
predicate rewrites what it wrote. The capture module's `.claude.md` (and its `AGENTS.md` mirror)
now says exactly that: **seven live producers plus one historical one, which is not to be read as
agreeing by construction.** `computeFingerprint`'s docstring said 670 was "the same expression
migration 412's backfill used except for the amount segment" — also corrected, as was
`migrationApService.ts:131`, which still described the key as `lower(vat|invoice_number|total)`.

**Round-8 tests.** `duplicateDetectionService.test.ts` +1 (`İ` and a trailing sigma survive
unfolded; the ASCII letters around them still fold). `k015-…int.test.ts`: the TS/SQL agreement
table gains three Unicode rows, its SQL oracle now folds with `translate()` as 670 does, and the
670 re-backfill case gains a bill numbered `…-İΣ` whose rewritten key must be one
`computeFingerprint` reproduces AND must NOT be the string either fold-by-case implementation
gives. Integration file 25 passed; the two fingerprint unit files 28 passed; full unit suite with
`DATABASE_URL` unset **793 files, 9444 passed / 234 skipped, 0 failed**; `tsc --noEmit` clean;
`eslint` on both changed source files clean; `agent-docs:check` OK (74 mirrors).

**Mutations (file copies, restored and diffed byte-identical against the copy).**
- **M-A** — `asciiLower(...)` back to `.toLowerCase()`: unit test RED
  (`expected 'no-vat|i̇nv-1|115.00' to be 'no-vat|İnv-1|115.00'`) and the integration agreement
  test RED.
- **M-B** — 670's two `translate()` calls back to `lower()`: integration RED
  (`expected 'no-vat|…-iσ|1…' to be 'no-vat|…-İΣ|1…'`).

**Migration.** None added. 670 is unmerged and fixture-only, so it was edited in place, as in
round 7. Its deploy pre-check (the cross-tenant supplier query in round 6) is unchanged and still
applies.

**Historical data.** No new impact. 670 already rewrites every stored fingerprint; this round only
changes WHICH string it writes for a row carrying a non-ASCII cased character, and those rows were
mis-keyed under either previous implementation. Nothing outside 670 rewrites the column.

**Not done.** `purgeExpiredDeletes` stays UNCALLED (round 6, L-3) — unchanged and deliberate.
`sageImportService` register items and the L-2 fingerprint-scale adjudication are unchanged.

**PR state — MUST be read before merging.** `origin/fix/audit-k015-k089-migration-balance-due` is
**four commits behind local** (`242bf867f`, `78fa01e21`, `b6268778b`, `06f1f5218`), plus this
round's commit — five. PR #373 therefore shows a state in which the blank-number and unmapped-column
refusals, the third fingerprint producer, and the supplier-VAT source are all absent. This session
does not push. **Do not read or merge #373 until the branch is pushed.**
