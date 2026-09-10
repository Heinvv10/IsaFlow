# K-053 round 2 — review findings on ccf775a2

Blind review of ccf775a2 (`scratchpad/review-k053.md`): 2 HIGH, 4 MEDIUM, 3 LOW. All addressed here.

**HIGH-1 — aging diverged from the subledger snapshot.** `ar/.claude.md:8` and `ap/.claude.md:9` require `arAgingService` and `arSubledgerService` to run on ONE population; round 1 filtered only aging, so `reconcile_subledger` reported the deleted amount as an unexplained residual (aged 1,000 vs subledger 1,750). `deleted_at IS NULL` added to `arSubledgerService.ts` and `apSubledgerService.ts`. Equality asserted in three states in `k053-soft-delete-gl-tie.int.test.ts`.

**HIGH-2 — aging no longer tied to the GL control account.** Approve posts a journal and cancel reverses it; soft-delete only ever set `deleted_at`, so filtering the document alone left its debit on account 1120 with nothing explaining the gap. New `core/softDeleteJournalService.ts` reverses the approval journal on delete and re-instates it on undo, through the canonical `reverseJournalEntry`, inside the caller's transaction and a savepoint. A delete is refused when the invoice carries payments or when the reversal has no open period, and the route answers 400 rather than 500 for both. Undo is handled because soft-delete is undoable: the link column keeps pointing at the ORIGINAL entry and the reversal chain carries the state (exactly one un-reversed head; live at odd depth), so delete reverses a live head and undo reverses a dead one. No new column, no migration, every step an ordinary auditable reversal.

**MEDIUM-1 — supplier ledger showed a payment whose bill was hidden** (statement read -300). Fixed at the source: a bill or invoice with `amount_paid > 0` can no longer be soft-deleted, mirroring cancel's "Cannot cancel invoice with payments".

**MEDIUM-2 — "kept being chased" was true of the commit message, not the code.** The commit cannot be amended, so the code now matches the claim: `deleted_at IS NULL` added to `dunningService`, `dunningCronService`, `statementEmailService`, `customer-statement.ts` (both queries), `smart-reminder.ts`, `supplierStatementService` and `supplierStatementBalancesService`. `dunningAdmin.ts` is deliberately NOT filtered — it lists sends that already happened, and hiding them would edit the audit history.

**MEDIUM-3 — MCP figure contract.** `ar.subledger.v1` and `ap.subledger.v1` `excludes` strings now name soft-deleted documents and say the journal is reversed with them.

**MEDIUM-4 — remaining consumers.** The chase and statement surfaces are fixed above. Still on the old population and NOT changed here: `settlementFlagService`, `unpostedDocumentService`, `unappliedCashService`, `capture/supplierStatementReconService`, `cashFlowForecastDataService`, `kpiDashboardService`, `kpiChartsService`, the VAT201/`vatBoxBasis`/`vatReconciliationService`/`drcVatService` family, `transactionReportingService`, `purchases-by-supplier`, `sales-by-customer`, `sales-by-item`. Each is a separate figure with its own contract; they belong in their own change, not smuggled into this one.

**LOW-1** — dated entries added to `ar/.claude.md` and `ap/.claude.md`; `agent-docs:check` OK on 74 mirrors. **LOW-2** — the second-company test asserts tenant scoping, not the predicate, and passes either way by design; recorded, not changed. **LOW-3** — `reports-supplier-ledger` invoice leg gained the `status NOT IN ('draft','cancelled')` filter it never had, so the statement population matches AP aging.

**Close-readiness.** The reviewer is right that `gl/closeReadinessChecks/arSubLedgerCheck.ts` and `apSubLedgerCheck.ts` must NOT gain the predicate while the GL still carries deleted documents' journals. HIGH-2 removes that constraint for documents deleted from now on, but NOT for the historical rows below — so those two checks are still left alone.

**Historical impact — read-only, NOT run here.** Round 1's query counts the money leaving aging. This one finds the already-deleted documents whose journal still stands, which is where the GL now sits over the subledger:

```sql
SELECT 'ar' AS side, ci.company_id, count(*),
       sum(ci.total_amount) AS gl_over_subledger
FROM customer_invoices ci
JOIN gl_journal_entries e ON e.id = ci.gl_journal_entry_id
WHERE ci.deleted_at IS NOT NULL AND e.status = 'posted' AND e.reversed_at IS NULL
GROUP BY ci.company_id
UNION ALL
SELECT 'ap', si.company_id, count(*), sum(si.total_amount)
FROM supplier_invoices si
JOIN gl_journal_entries e ON e.id = si.gl_journal_entry_id
WHERE si.deleted_at IS NOT NULL AND e.status = 'posted' AND e.reversed_at IS NULL
GROUP BY si.company_id;
```

Those rows are not repaired by this change — reversing them is a dated GL correction and needs a decision on the reversal date, so it is a separate, approved piece of work.

**Tests (round 2).** `tests/integration/k053-soft-delete-gl-tie.int.test.ts` (6: AR/AP tie of aging = subledger = control account through delete and undo, the payments refusal, the closed-period refusal, and `unbalancedJournals() === 0` at every step) and `tests/integration/k053-soft-delete-chase-surfaces.int.test.ts` (4: emailed AR statement, `loadInvoiceCtx`, AP statement, the smart-reminder route). With round 1's two files: **4 files, 16 tests, all passing** on fixture Postgres.

**Mutation proof (round 2).** Four separate reverts, each re-run against the fixture DB:
- reversal suppressed in `reverseDocumentJournalForDelete` → 3 of 6 RED in the GL-tie file;
- `deleted_at IS NULL` removed from `arSubledgerService`/`apSubledgerService` → 2 of 6 RED (aging and the subledger diverge, which is exactly HIGH-1);
- `amount_paid` guard disabled → the payments-refusal test RED;
- `deleted_at IS NULL` removed from `statementEmailService`, `dunningService`, `supplierStatementService` and `smart-reminder.ts` → all 4 chase-surface tests RED.
Every file restored afterwards and the diff confirmed byte-identical.

**Not covered by a test.** `dunningCronService` carries the same one-line predicate but `runDunningCron` scans every company with `auto_send_enabled` and can send mail, so it is not driven against the shared fixture database. Noted at the top of the chase-surface test file.

**Gates.** `bunx tsc --noEmit` clean · `bunx eslint` clean on all 14 changed `src`/`pages` files · `bun run agent-docs:check` OK on 74 mirrors · full unit suite (DATABASE_URL unset) 9,433–9,434 passed / 234 skipped. Two runs each showed ONE different file failing on a 10s vitest timeout (`cashFlowReport`, then `bankAllocationUnwind`); both pass in isolation and the host load average was 128. Neither imports anything this change touches.
