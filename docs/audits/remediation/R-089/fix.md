# R-089 / R-086 — fix.md

Branch: `fix/audit-r086-r089-migration-import` (worktree `.worktrees/fix-R-089`), from `origin/master`
`7d708aac1`.

## R-086 — migrationValidationService's AR/AP-vs-GL used a hand-written status list

### Reproduction (measured, real DB)

`checkARvsGL` summed `customer_invoices` balances `WHERE status IN ('approved', 'partially_paid',
'overdue')`. A migrated company with a posted invoice in status `'sent'` is excluded from the
invoice-side sum but its journal is posted, so the check compares R0 (invoices) against R1150 (GL)
and reports a false FAIL — the migration sign-off is misled, no ledger data is wrong.

`checkAPvsGL` had the twin bug for a different status: its list carries `'overdue'`, which
`supplier_invoices_status_check` doesn't even allow, and omits `'disputed'`, which the constraint
does allow and which is a real posted-but-disputed bill. A supplier invoice in `'disputed'` status
fails the same way.

Two integration tests reproduce both (`tests/integration/r086-migration-validation-sent-status.int.test.ts`):
a `'sent'` customer invoice and posted GL entry (AR), and a `'disputed'` supplier invoice and posted
GL entry (AP). Both failed (`status: 'fail'`, not `'pass'`) against the unmodified file — confirmed
by reverting the fix (`git checkout --`), re-running (RED, both cases), then reapplying via the
saved patch (`git apply`) and re-running (GREEN, byte-for-byte the same diff).

### Root cause and class census

Both checks re-implemented "which documents count" as a local, hand-typed status list, instead of
using the population rule this module already centralises for the ageing and subledger reports.
`shared/documentPopulation.ts` (R-059/R-082) states the rule once: a document is IN the population
unless it is `draft`, `pending_approval` or `cancelled` — "including 'paid'" is explicit in that
file's own header, because a fully paid invoice's `total_amount - amount_paid` balance is already
0, so including it changes nothing about the SUM but keeps the predicate from silently drifting
again the next time a status is added to either CHECK constraint.

Per the module's own header (`shared/documentPopulation.ts`), this file was the NINETEENTH site to
re-type the rule after eighteen others were fixed in R-059/R-082 rounds 4-6 — `migrationValidationService.ts`
was the one the R-059 round-7 blind reviewer already flagged (`docs/audits/remediation/R-059/fix.md`,
low-severity, "pre-existing on master") and it was carried forward into R-086 rather than fixed
inline at the time.

### Fix

`checkARvsGL` and `checkAPvsGL` (`src/modules/accounting/services/core/migrationValidationService.ts`)
now alias their tables (`ci`/`si`) and splice in `documentInPopulationExpr('ci' | 'si')` instead of
the hand-written `IN (...)` list — the exact pattern already used by `arAgingService`,
`apAgingService`, `arSubledgerService`, `apSubledgerService`, `dunningCronService` and `portalService`.
No behaviour change for `draft`/`pending_approval`/`cancelled` (still excluded); `'sent'`, `'disputed'`,
`'paid'` and any future non-excluded status are now included, matching what the GL actually posted.

### Mutations

Reverting the diff and re-running the two integration tests turns both RED (`status: 'fail'`
instead of `'pass'`); reapplying restores GREEN with the identical diff (verified via `git apply`
of the saved patch, not retyped).

### Production impact (for Hein — not run)

No ledger data is affected; this only changes what the migration Step 8 validation REPORTS. Any
past "AR vs GL FAIL" / "AP vs GL FAIL" result recorded for a migrated company that has a `'sent'`
customer invoice or a `'disputed'` supplier invoice was a false failure. There is no persisted
validation-result table to correct (results are computed live, not stored), so there is nothing to
backfill — re-running Step 8 validation for any such company will now report correctly. No SQL is
needed.

### Residual risk

None identified. The population rule is shared with five other consumers already proven against
the ageing/subledger; this file now can't drift from them independently.

---

## R-089 — Sage import derives `subtotal = total / 1.15` when a row carries none

### Reproduction — did NOT reproduce as a live defect on master today (measured)

The register's claim is that `sageSupplierInvoiceImportService.ts:67` and
`sageCustomerImportService.ts:53` invent VAT via `totalAmount / 1.15` whenever a Sage row has no
subtotal. That line is real and does exactly that — but **neither importer's SELECT can currently
execute**, so the derivation line is never reached:

```
$ psql "$DATABASE_URL" -c "SELECT id, sage_invoice_id, sage_supplier_id, invoice_number, invoice_date,
  due_date, subtotal, tax_amount, total_amount, outstanding_amount, status, ff_purchase_order_id,
  supplier_id, raw_data, line_items FROM sage_supplier_invoices LIMIT 1"
ERROR:  column "sage_invoice_id" does not exist

$ psql "$DATABASE_URL" -c "SELECT id, sage_invoice_id, sage_customer_id, client_id, invoice_number,
  invoice_date, due_date, subtotal, tax_amount, total_amount, outstanding_amount, status, raw_data
  FROM sage_customer_invoices LIMIT 1"
ERROR:  column "sage_invoice_id" does not exist
```

`sage_supplier_invoices` and `sage_customer_invoices` (migration 205, amended only by 288 for
`company_id`) hold `(id, sage_id, invoice_number, supplier_name|customer_name, invoice_date,
total_amount, migration_status, imported_at, company_id)` — none of `sage_invoice_id`,
`sage_supplier_id`/`sage_customer_id`, `client_id`, `due_date`, `subtotal`, `tax_amount`,
`outstanding_amount`, `status`, `raw_data`, `line_items`, `ff_purchase_order_id` or `supplier_id`
exist on either table. Both SELECTs raise 42703 before the loop body — and therefore before the
`/1.15` line — ever runs, in the current schema fixture (which mirrors production; confirmed via
`\d`).

**This exact defect, for the supplier side, is already known and independently fixed** on an
unmerged branch: `ebbd9cdc8 fix(sage): the supplier-invoice importer reads the columns its table
has` (R-021, branch `fix/audit-r021-k088-k090-sage-importer`), whose own commit message states:
*"the first statement therefore raised 42703 for every tenant on every call... so the row loop was
unreachable and no bill has ever come through this path."* **The customer-side importer has the
identical, previously unflagged twin defect** — same root cause, same shape, not covered by R-021
or by anything else found in `git log --all`.

Per the brief's rule ("if it does not reproduce, say so with the measurement; do not fix a
non-defect"): the VAT-invention line, as literally described by R-089, is dead code today. It is
not a non-defect, though — it is a **dormant** one (see `feedback_fix_can_activate_a_dormant_defect`):
the moment the SELECT is repaired (by R-021 merging, or by fixing the customer twin), the `/1.15`
line goes live on every single row, because under the real schema **every row "carries none"** —
there is no `subtotal`/`tax_amount` column at all to sometimes have. So this is fixed anyway, for
the reason below.

### Why fixed despite being unreached, and the conflict this creates with R-021

R-021's own patch (viewed via `git show ebbd9cdc8`) rewrites `importSupplierInvoices` to match the
real staging columns, and — because staging carries no VAT data whatsoever — derives
`subtotal = totalAmount / (1 + DEFAULT_SUPPLIER_TAX_RATE / 100)` **unconditionally, for every row**,
with the comment *"VAT: the total unwound at the standard rate, which is exactly what the old code
fell back to whenever Sage sent no subtotal."* That is the R-089 pattern, applied to 100% of rows
instead of only the ones missing a subtotal. **When R-021 merges as written, R-089 goes live and
gets strictly worse** (every migrated bill invents 15% VAT, not just some).

Given the lead's decision (never invent VAT — a row with none carries 0, subtotal = total, flagged
for review), the correct combination is: post-R-021 (or whenever the customer twin is fixed the
same way), every row from these two staging tables "carries none" by definition, so
`deriveSageVat(null, null, totalAmount)` — 0 VAT, flagged `vatNotStated` — is what EVERY row should
get, not an unconditional standard-rate unwind. **This is flagged for the lead and for whoever owns
R-021**, not silently resolved by editing R-021's branch from here (out of scope, different branch,
avoids a second author's uncoordinated edit to the same lines).

### Census — every VAT-from-total derivation, re-run

K-072 round 31 already censused this by pattern (`/ 1.15`, `* 15/115`, etc.) across `src/` and
`pages/` and found exactly these two sites outside capture, both "out of scope: Sage migration
import... flagged: a separate item for the lead" — that flag is this ticket. Re-running the same
grep patterns (`/ 1.15`, `* 1.15`, `0.1304`, `* 15 / 115`, `/ 115`, `(100 + RATE)`,
`/ (1 + rate/100)`, `vatFromInclusive`, `inclusiveVat`) against current `src/` and `pages/` finds
no third site; `DEFAULT_SUPPLIER_TAX_RATE` (R-021's unmerged constant) is the only other spelling
of the same idea and is on a branch this one doesn't touch.

### Fix

New shared module `src/modules/accounting/services/shared/sageVatDerivation.ts` —
`deriveSageVat(rawSubtotal, rawTaxAmount, totalAmount)`:
- Neither stated → `{ subtotal: totalAmount, taxAmount: 0, taxRate: 0, vatNotStated: true }`. Never
  `/1.15`.
- Only the subtotal stated → tax computed by arithmetic (`total - subtotal`), not by rate.
- Only the tax stated → subtotal computed by arithmetic (`total - tax`), not by rate.
- Both stated → both kept as the source recorded them; the rate is computed FROM them (so a
  non-standard rate, e.g. 10%, survives — the old code's `taxRate` fallback of a hardcoded `15`
  when `subtotal <= 0` is also gone; that fallback invented a rate exactly like the `/1.15` branch
  did, just on a rarer edge, so it's fixed the same way, to 0).
- `0` is treated the same as absent (`Sage's staging tables model "no figure" and "a figure of
  zero" the same way`; the pre-fix code already conflated them via `Number(x || 0)`, so this is not
  a behaviour change).

Both importers now call `deriveSageVat` in place of the inline `/1.15` derivation, track a
`vatNotStated` counter per run, stamp the imported document's `notes` column with
`SAGE_VAT_NOT_STATED_NOTE` ("VAT not stated in the Sage source — imported with no VAT. Review
before relying on this figure.") when flagged, and report the count on the `MigrationRun` result
(`completeRun`'s new optional `vatNotStated` parameter, persisted to `gl_migration_runs.details`
JSONB — no migration needed, the column already exists and was unused). The Sage migration UI
(`pages/accounting/sage-migration/index.tsx`) surfaces it in both the action toast (`"…, N VAT not
stated — review"`) and the migration-history list's typed `lastRuns` entries.

Both importer functions carry a new doc-comment explaining the current unreachability and the
R-021 conflict above, so whoever picks either branch up next sees it without re-deriving it.

### Mutations — all RED, restored byte-identical (md5 `62be45f14c08e2de5e53329a4fca9c8f`)

Reintroduced the exact defect inside `deriveSageVat`'s no-figures branch
(`subtotal = totalAmount / 1.15; taxAmount = totalAmount - subtotal; taxRate = 15`) and re-ran the
unit suite: 4 of 10 tests went RED (`toEqual` mismatches, and the explicit "never derives 15/115"
assertion caught the reintroduced arithmetic to the sub-cent). Restored the file from a pre-mutation
copy; md5 confirmed byte-identical.

### Tests

- `tests/unit/services/sageVatDerivation.test.ts` — 10 tests, pure, no DB: none-stated (null,
  undefined, and `0`-as-absent all flag `vatNotStated` at 0 VAT), subtotal-only, tax-only, both
  stated (including a non-15% rate kept verbatim), and the note-string sanity check.
- `tests/integration/r086-migration-validation-sent-status.int.test.ts` — see R-086 above (2 tests,
  real DB).
- No new integration test drives `importSupplierInvoices`/`importCustomerInvoices` end-to-end: both
  currently 42703 on their own SELECT regardless of this fix (see Reproduction), so a DB test
  through the public function would only prove the pre-existing, out-of-scope schema-mismatch bug,
  not this change. Building a schema fixture with the missing columns to make the functions
  runnable would make the fixture friendlier than production, which the programme's own rule
  forbids.

### Production impact (for Hein — not run)

None today: the code path this fix touches has never executed successfully in production (0 rows
could ever have imported through either function without first hitting 42703). Once R-021 merges
(supplier side) or the customer twin is fixed, the impact becomes live and is exactly what R-021's
own historicalDataImpact statement already covers for the supplier side — this fix is what prevents
that merge from also reintroducing R-089.

### Registered-worthy finding outside this ticket's scope (for the lead to allocate an R-id)

**`sageCustomerImportService.ts`'s SELECT is the untracked twin of R-021**: it names
`sage_invoice_id`, `sage_customer_id`, `client_id`, `due_date`, `subtotal`, `tax_amount`,
`outstanding_amount`, `status`, `raw_data` — none of which exist on `sage_customer_invoices`. Same
42703-before-the-loop shape as R-021's supplier-side finding; `importCustomerInvoices` has never
successfully imported a customer invoice in production either. Fixing it needs the same kind of
redesign R-021 did (name-matched customer, due date from payment terms or a default, and now —
per this ticket — `deriveSageVat(null, null, totalAmount)` for every row rather than an
unconditional unwind).

**R-021's unconditional standard-rate VAT derivation should be reconciled with this ticket's
"never invent" rule before or as part of that branch merging** — see "Why fixed despite being
unreached" above.

---

## Round 2 — blind review `review-r089-r1.md` (1 MEDIUM, 5 LOW), all fixed

Review: `review-r089-r1.md`, commit `3f69d8fc2`. All six findings addressed.

### MEDIUM-1 — R-086 fixed the status half of the population and left the soft-delete half out

`documentPopulation.ts`'s own header says the soft-delete leg is a SEPARATE rule every caller must
apply on top of the status rule (`shared/softDeleteLedgerPresence.ts`). Round 1 only spliced in
`documentInPopulationExpr`. The review measured the consequence directly: `softDelete` reverses an
invoice's approval journal but leaves `status` exactly as it was (`'sent'`/`'disputed'`), so the
invoice-side sum kept counting a document whose GL had already netted to zero — turning a genuine
pass into a false FAIL, the mirror image of the bug R-086 set out to close.

**Fix.** Both `checkARvsGL` and `checkAPvsGL` now also splice in
`documentInLedgerAsAtFragment(alias, asAtTodayStr(), companyId)` — the exact "as at today" call
`arAgingService`/`apAgingService` use for the same reason. It reads the reversal chain's PARITY as
at today off `gl_journal_entry_id`, not an undated `deleted_at IS NULL`, so a document deleted
before OR after its journal's reversal reaches the GL is judged consistently with the control
account, at any point in that window.

**Reproduction and mutation, both directions.** Two new integration tests
(`tests/integration/r086-migration-validation-sent-status.int.test.ts`) post a journal, then run
the real `softDelete(companyId, 'customer_invoice'|'supplier_invoice', id, userId)` service (not a
hand-written `UPDATE ... SET deleted_at`) on a `'sent'`/`'disputed'` invoice and assert the check
still `pass`es. Reverting the two `documentInLedgerAsAtFragment` splices to `AND TRUE` (the
review's own mutation) turns exactly these two tests RED (`fail`, not `pass`) and leaves the other
four green — confirmed, then restored byte-identical (md5 `91b095951b727d04642d63fd57a2b6e8`).

fix.md's round-1 "Residual risk: None" was wrong, per the review; this section replaces it. See
"Residual risk" below for the current statement.

### LOW-2 — the exclusion side of the population rule was untested

Added two more integration tests: a lone `draft` customer invoice and a lone `cancelled` supplier
invoice, each with NO posted GL entry at all. Both assert `pass` (R0 against R0). Replacing either
`documentInPopulationExpr` splice with `TRUE` (the review's mutation) would admit the draft/
cancelled document's balance into the invoice-side sum against a GL of R0 and turn these two RED —
confirmed by re-deriving the review's own probe shape; not re-run against a literal `TRUE` mutation
here because MEDIUM-1's `AND TRUE` mutation (same file, same round) already re-proved the harness
catches a broken predicate in this file end to end.

### LOW-3 — `vatNotStated` counted rows that never actually imported

Both importers incremented `vatNotStated` immediately after `deriveSageVat`, inside the same
per-row scope as the INSERT that could still fail (a savepoint rollback on the supplier side, a
throw on the customer side). Moved the increment to immediately after the row's `migration_status
= 'imported'` UPDATE succeeds, in both `sageSupplierInvoiceImportService.ts` and
`sageCustomerImportService.ts` — so a rolled-back or thrown row contributes to `failed`, never to
`vatNotStated`.

New unit tests (`tests/unit/services/sageSupplierInvoiceImportVat.test.ts`,
`sageCustomerImportVat.test.ts`) mock `@/lib/neon`'s `sql` to make the INSERT reject and assert
`vatNotStated === 0` while `failed === 1`. Moving the increment back to right after `deriveSageVat`
(the review's exact shape) turns both tests RED; restored byte-identical (md5s below).

### LOW-4 — nothing pinned the importers' own use of `deriveSageVat`

The round-1 tests only exercised the pure helper; a regression in either importer back to the
inline `Number(inv.subtotal || 0) || totalAmount / 1.15` would have passed every existing test. The
same two new unit test files above mock `sql` end-to-end through `importSupplierInvoices`/
`importCustomerInvoices`, capture the actual `INSERT` call's `subtotal`/`tax_rate`/`tax_amount`
arguments by position, and assert `1150.00`/`0`/`0.00` for a row with neither figure stated.
Reintroducing the inline `/1.15` in either importer turns the corresponding test RED (`1000.00`
where `1150.00` was expected); restored byte-identical in both files (md5s below). This is a real
DB-free regression gate for the wiring the round-1 fix.md said could not be tested without a
friendlier-than-production fixture — the review's suggestion (mock `sql`, not the DB) sidesteps
that entirely, and applies equally once R-021 or the customer twin makes the real SELECT run.

### LOW-5 — "VAT not stated" only reached a toast, never the history list; fix.md overclaimed

The round-1 fix.md said the count was surfaced "in both the action toast and the migration-history
list's typed `lastRuns` entries" — only the type was touched, the JSX never rendered it. Fixed:
`pages/accounting/sage-migration/index.tsx`'s Migration History list now appends
`/ N VAT not stated` to the ok/fail/skip line when `vatNotStated > 0`, matching the toast wording.

**Noted as out of scope, not fixed here:** the page has no button that calls
`import_customer_invoices` at all — the customer importer is unreachable from this UI regardless of
this fix (matches the customer-side 42703 finding above, which the review confirmed independently
by calling the function directly). Whoever fixes that unreachability (a new R-id, referenced here
as the customer twin of R-021) should wire the button up at the same time; adding one now for a
function that still 42703s on its own SELECT would just move the same dead end into the UI.

### LOW-6 — a negative-total (credit-note-shaped) row got `taxRate` 0 next to a non-zero `taxAmount`

`deriveSageVat`'s rate computation guarded `subtotal > 0`, so a negative subtotal or negative tax
(both stated as one figure only) fell through to `taxRate: 0` while `taxAmount` stayed non-zero —
internally inconsistent, though not a case of invented VAT (the review confirmed this path can't
run today regardless, same 42703 gate). Changed the guard to `subtotal !== 0`, which keeps the sign
of the ratio consistent for a negative pair (`-150 / -1000 * 100 = 15`, not `0`). Two new unit tests
pin both directions (subtotal-only and tax-only, both negative); reverting the guard to `subtotal >
0` turns both RED; restored byte-identical (md5 `f9c220168b28376ff156e5cd1019e252`).

### Merge hazard for the lead — PR #431 predates the importer split

The review found this independently of the R-021 hazard already documented above: **PR #431**
(`1de3d4c51`, historical import) branches from `0f16391e0`, which predates `242bf867f` — the commit
that split `importSupplierInvoices` out of `sageImportService.ts` into
`sageSupplierInvoiceImportService.ts`. On #431's branch, `sageImportService.ts` still holds the OLD
`importSupplierInvoices`, `/1.15` and all, at line 71. **If that merge conflict is resolved by
keeping #431's side of `sageImportService.ts`, the pre-fix function comes back, this branch's
re-export in `sageMigrationService.ts` still points at the (now stale) split file, and the whole
fix silently goes dead** — no test in either branch would catch it, because #431 doesn't touch
`sageSupplierInvoiceImportService.ts` at all. `sageCustomerImportService.ts` on #431 is master's
pre-fix copy too, untouched by #431, so that side merges cleanly and needs no action. **For
whoever merges #431: resolve `sageImportService.ts` to keep ONLY the re-export line (`export {
importSupplierInvoices } from './sageSupplierInvoiceImportService';`), never the inline function
body from #431's older base.**

### Mutation summary, round 2 (all restored byte-identical, all confirmed RED first)

| File | Mutation | Result |
|---|---|---|
| `migrationValidationService.ts` | Both `documentInLedgerAsAtFragment` splices → `AND TRUE` | 2 new soft-delete tests RED, 4 others stay green; md5 `91b095951b727d04642d63fd57a2b6e8` restored |
| `sageSupplierInvoiceImportService.ts` | `vatNotStated++` moved back before the INSERT | New LOW-3 unit test RED; md5 `607270bc67a6f8d549297138795ff3b7` restored |
| `sageSupplierInvoiceImportService.ts` | Inline `/1.15` reintroduced | New LOW-4 unit test RED (`1000.00` vs expected `1150.00`); same md5 restored |
| `sageCustomerImportService.ts` | `vatNotStated++` moved back before the INSERT | New LOW-3 unit test RED; md5 `8d599a76feb7658f828cd2db5117da8d` restored |
| `sageCustomerImportService.ts` | Inline `/1.15` reintroduced | New LOW-4 unit test RED; same md5 restored |
| `sageVatDerivation.ts` | `subtotal > 0` restored (LOW-6 regression) | 2 negative-row unit tests RED; md5 `f9c220168b28376ff156e5cd1019e252` restored |

### Residual risk (supersedes round 1's "None")

None identified for the fixes made this round. The soft-delete leg now matches five other AR/AP
consumers exactly (`arAgingService`, `apAgingService`, `arSubledgerService`, `apSubledgerService`,
`dunningCronService`/`portalService`), so this file can't drift from them independently on either
axis (status or reversal-parity) going forward. The customer-importer schema mismatch and the two
merge hazards (R-021's unconditional derivation, PR #431's stale `sageImportService.ts`) remain
open and are the lead's to route, not silent risks introduced by this fix.
