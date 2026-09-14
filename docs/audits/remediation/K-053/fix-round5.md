# K-053 round 5 — the seven findings of `review-k053-r4.md`

Reviewed commit `eea2b1c64`. 0 HIGH · 2 MEDIUM · 5 LOW, all seven fixed; nothing disputed.

**MEDIUM-1 — the as-at statement surfaces still asked the UNDATED question. FIXED.**
`statementEmailService.fetchStatementData`, `supplierStatementService`,
`supplierStatementBalancesService` (both legs) and `pages/api/accounting/customer-statement`
(detail AND the separate totals aggregate) now take `documentInLedgerAsAtFragment`, so a
statement drawn as at a date before the delete states the same balance as aging and the
control account. The comments claiming "same population as apAgingService" are true again.
The AR mirror the review did not name — `statementEmailService` — carried the identical
defect and is fixed with it. `dunningService`, `dunningCronService` and `smart-reminder` keep
the undated predicate on purpose: they chase as at NOW and take no as-at date.

**MEDIUM-2 — `reports-supplier-ledger` kept an undated exclusion. FIXED.**
`AND ${documentInLedgerAsAtFragment('si', dateToVal ?? fmtDate(new Date()), companyId)}`. The
comment no longer argues both sides: the nullable upper bound is named as the reason for the
fallback, and the "cannot carry a live payment" argument is stated once, as the reason a
presence filter is safe where a status filter is not.

**LOW-1 — `purgeExpiredDeletes` would undo the fix. FIXED (cascade) + recorded.**
The purge now deletes the matching `soft_delete_journal_reversals` rows, scoped by
`(company_id, entity_id)` pairs so another tenant's row with the same entity id survives. The
header says why a caller must not be added lightly: hard-deleting the invoice destroys the only
row the dated predicate can evaluate, permanently, for every as-at date before the delete.

**LOW-2 — refusal-vs-fault decided by type PLUS one substring. FIXED.**
`resolveReversalDate`'s two throws are `ReversalPeriodError` (new, exported from
`journalEntryPostingService`); `isUserFixable` reads no message text at all.

**LOW-3 — the parity proof rested on an undocumented monotonicity assumption. FIXED.**
`softDeleteLedgerPresence`'s header names `resolveReversalDate` as the precondition, and
`k053-out-of-order-reversal-chain.int.test.ts` hand-builds a back-dated chain in SQL and pins
the failure mode, alongside the guard that makes it unreachable.

**LOW-4 — doc inaccuracies. FIXED.** "six sites" → eight in `fix-round4.md`; `ap/.claude.md`
no longer says the services gained `deleted_at IS NULL`; `ar/.claude.md` carries the new name
and the precondition. `AGENTS.md` mirrors regenerated.

**LOW-5 — the fragment returns an awaitable. FIXED.** Renamed to
`documentInLedgerAsAtFragment` at all 8 call sites, with an INTERPOLATION ONLY note.

**Files.** `shared/softDeleteLedgerPresence.ts` · `ar/{arAgingService,arSubledgerService,statementEmailService}.ts` ·
`ap/{apAgingService,apSubledgerService,supplierStatementService,supplierStatementBalancesService}.ts` ·
`gl/closeReadinessChecks/{ar,ap}SubLedgerCheck.ts` · `gl/journalEntryPostingService.ts` ·
`core/softDeleteService.ts` · `pages/api/accounting/{customer-statement,reports-supplier-ledger,soft-delete}.ts` ·
three `.claude.md` + mirrors.

**Tests.** 11 integration files / 47 tests on fixture Postgres (3 new files, 12 new tests);
`tests/unit/services/core/softDeleteRouteErrorClass.test.ts` 5 tests. Six mutations, each RED —
see `green.log`. Full unit suite with the fixture env unset: 9,439 passed / 234 skipped, 0 failed.

**Migration / rollback.** None this round (653 is unchanged). Rollback = revert the commit.

**Historical impact.** No data is written or repaired. Statements and supplier ledgers drawn as
at a PAST date now include documents deleted after that date, so a re-run of an old statement
can differ from the copy that was sent — in the direction that ties it to the GL. The
round-4 impact SQL is unchanged and still not run against production.

**Limits.** `supplierInvoiceWorkflowService.ts` remains at 516 lines (the reviewer ruled this
acceptable for this commit and wants its own). `purgeExpiredDeletes` still has no caller, and
the trade-off it forces is recorded rather than decided.
