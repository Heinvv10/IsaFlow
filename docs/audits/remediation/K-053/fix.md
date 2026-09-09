# K-053 — aging and the supplier ledger kept soft-deleted invoices

**Trigger.** Soft-delete (`pages/api/accounting/soft-delete.ts`) blocks only `status='posted'`; aging excludes only `'draft'`/`'cancelled'`. So every `approved`/`sent`/`partially_paid`/`overdue` document is both deletable and aged, and no aging query filtered `deleted_at`.

**Before → after.** The deleted document kept a balance in AR and AP aging, both drill-downs, and the supplier statement's rows and running balance (fixture: R1,750 reported, R1,000 live). Now `AND ci.deleted_at IS NULL` / `AND si.deleted_at IS NULL` in each query; only R1,000 is reported. The `OR deleted_at > NOW()` form the AR customer ledger uses was deliberately not copied — `deleted_at` is only ever set to `NOW()`.

**Files.** `arAgingService.ts` (getARAging, getARAgingDetail) · `apAgingService.ts` (getAPAging, getAPAgingDetail) · `pages/api/accounting/reports-supplier-ledger.ts` (invoice leg; the supplier-name lookup already filtered).

**Tests.** `tests/integration/k053-aging-includes-soft-deleted.int.test.ts` (2, validator's RED) + `tests/integration/k053-aging-soft-delete-adjacent.int.test.ts` (4: AR detail, AP detail, supplier ledger through the real route, second-company no-leak). 6 passed on fixture Postgres. Mutation check: reverting the three files takes 5 of 6 RED. Full unit suite 9,434 passed / 234 skipped; tsc and eslint clean. See `green.log`.

**Migration / rollback.** None. Rollback = revert the commit; nothing is written.

**Historical impact.** Every soft-deleted open document has been aged, chased and stated since deletion, and `purgeExpiredDeletes` (`softDeleteService.ts:256`) has no caller in `src/` or `pages/`, so those rows are permanent and may be years old. This filter REMOVES money from aging totals, which will not tie to published reports. Quantify first — read-only, NOT run here, run on a copy or by a DBA:

```sql
SELECT 'ar' AS side, company_id, count(*), sum(total_amount - COALESCE(amount_paid,0)) AS balance
FROM customer_invoices
WHERE deleted_at IS NOT NULL AND status NOT IN ('draft','cancelled')
  AND (total_amount - COALESCE(amount_paid,0)) > 0
GROUP BY company_id
UNION ALL
SELECT 'ap', company_id, count(*), sum(total_amount - COALESCE(amount_paid,0))
FROM supplier_invoices
WHERE deleted_at IS NOT NULL AND status NOT IN ('draft','cancelled')
  AND (total_amount - COALESCE(amount_paid,0)) > 0
GROUP BY company_id;
```

**Rounds 2-6.** See `fix-round2.md` (GL reversal on delete), `fix-round3.md`, `fix-round4.md`
(the exclusion dated to the reversal) and `fix-round5.md` (the as-at statement surfaces, the
typed reversal-period error, the purge cascade and the parity precondition) and `fix-round6.md`
(the AR customer ledger — the sixth as-at surface — the completed `deleted_at` census with a
disposition per site, the faithful `sql.unsafe` test mock, and the undo-window copy). The one-line
`deleted_at IS NULL` described above is superseded at every AS-AT surface by
`shared/softDeleteLedgerPresence.documentInLedgerAsAtFragment`; it survives only where the
question is asked as at NOW (dunning, the dunning cron, smart-reminder).

**Limits.** `purgeExpiredDeletes` is deliberately still uncalled and should stay that way — see
`fix-round6.md`; hard-deleting a soft-deleted invoice permanently breaks the sub-ledger/GL tie for
every past as-at date. Round 6 corrected the copy instead: the UI and the API now say the record is
hidden rather than erased, which is what actually happens. The supplier-ledger payment leg is
unchanged, and the on-screen statement still differs from the emailed one on credit-note valuation
and on having no opening balance (round 6, LOW-3 — its own item). Three files remain over the
300-line cap (`supplierInvoiceWorkflowService` 516, `journalEntryPostingService` 359,
`dunningService` 357), all pre-existing.
