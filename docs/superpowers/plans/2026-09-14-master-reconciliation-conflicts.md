# Master reconciliation — conflict resolution record

Merge commit `0e56caf74` (parents `cc7062f61` + `4fd8943e6`), follow-up fixes `4b42179c7`.
Merge base `0f16391e0`: 562 commits of `origin/master` against 1390 of the forensic-controls
programme. **99 conflicting files**, all accounted for below.

Read this against the diff. The shape of nearly every conflict was the same: master changed a
function this programme had wrapped in a controlled operation, so master's side carried a
behaviour change and ours carried the same code routed through the controls kernel. The standard
applied was *both intents survive* — taking "ours" drops a master bug fix, taking "theirs" removes
a control, and **neither is acceptable as a default**.

---

## 1. Request-transaction owners (5 files) — the hardest class

Master introduced `runOwnedContext` / `drainAfterCommit` (R-075: after-commit work starts only
after COMMIT, on its own connection) at exactly the point where this branch had put
`withControlRequest`.

| File | Master | Ours | Resolved |
|---|---|---|---|
| `src/lib/auth/withAuth.ts` | `runOwnedContext` + `drainAfterCommit`, context hoisted to `ctx` | `withControlRequest` + `ControlIntegrityError` → 500 | Nested: `runOwnedContext` outside, `withControlRequest` inside, on **one hoisted `ctx`**. `drainAfterCommit(ctx)` at the end of the function already referenced `ctx`, so an inline literal would have silently dropped every after-commit callback. Both enter `als.run` on the same store, so nesting is a no-op for ALS. |
| `src/lib/auth/bearerPipeline.ts` | same | same | Same composition on `txCtx`. |
| `src/lib/auth/withPlatformAdmin.ts` | `runOwnedContext` + drain | `withPlatformImportRequest` | Same nesting. Follow-up fix: the platform-import lifetime's `integrity()` trips on `criticalAuditFailed` and threw before master's M6 branch could answer, so that one case is now swallowed and left to M6 — same ROLLBACK, same dropped queue, but `AUDIT_WRITE_FAILED` instead of a bare 500. Other integrity failures still propagate. |
| `src/lib/api-error-handler.ts` | typed `respondIfLockTimeout` (4 wrapper classes) | raw `isRetryableLockFailure` (55P03 / 40P01) | **Complementary, not duplicates.** Typed check first (specific message), raw as catch-all. Both answer 503 + `Retry-After`. |
| `src/lib/billing/withFlowMeter.ts` | `refundBalanceAfter` capture | `!res.headersSent` guard on `X-Flow-Refunded` | **Took master wholesale** — see §7. |

---

## 2. Controlled writers — master's fix inside our wrapper (44 files)

The routine pattern: master's changed logic placed inside our permit / control context, with our
parameter threading preserved. Listed here by module; the entries that needed real judgement are
broken out in §3.

- **bank (10):** `autoPostGateService`, `autoPostUndoService`, `bankAllocationService`,
  `bankAllocationUnwind`, `bankImportService`, `bankRulesMatchingHelpers`,
  `bankRulesMatchingService`, `bankRulesService`, `bankTransferAutoLink`, `bankTransferLinkService`
- **AR (6):** `creditNoteCancelService`, `customerPaymentAllocationService`, `customerPaymentService`,
  `receiptAllocationLines`, `receiptMatchConfirmService`, `recurringInvoiceService`
- **AP (4):** `batchPaymentService`, `supplierBankPaymentService`, `supplierInvoiceWorkflowService`,
  `supplierPaymentWorkflowService`
- **GL (5 + 1 type):** `accountMergeService`, `assetDepreciationPosting`, `chartOfAccountsService`,
  `journalEntryPostingService`, `yearEndCloseService`, `types/gl.types.ts`
- **payroll (5):** `payPackageService`, `payrollBatchService`, `payrollEmployeeComponentService`,
  `payrollRunService`, `uifDeclarationService`
- **core (4):** `duplicateMergeService`, `emailService`, `paymentVoidService`, `sageImportService`
- **items (3):** `adjustmentService`, `depreciationRunPreview`, `depreciationRunService`
- **admin (1):** `sageMigrationCommitService`
- **MCP tools (4):** `writeBulkApproveSupplierInvoices`, `writeFiscalPeriods`, `writeJournalReverse`,
  `writePayrollRun`
- **API routes / UI / CI (7):** `extension-ingest.ts`, `bank-transactions-bulk-commit.ts`,
  `capture/[id]/post-expense.ts`, `receipt-to-journal.ts`, `year-end.ts`,
  `bank-transactions/index.tsx`, `year-end/index.tsx`, `useBankTxActions.ts`,
  `scripts/ci/check-vat-guard-coverage.ts`

**Where our branch had MOVED the code, master's fix was ported to its new home rather than dropped.**
Each of these is a behaviour change in a file that carried no conflict marker, so they are the most
easily missed part of the merge:

| Master's fix | Ported into |
|---|---|
| Recurring invoice drawn from the company number sequence (`insertWithReservedNumber`) | `ar/recurringInvoiceControl.ts` — our prepared run was minting `INV-R-<uuid>`, i.e. not the sequence at all |
| `escapeLikeLiteral` on rule patterns; `rulePattern(rule)`; `isRetryableContention` | `bank/bankRulesAutoPostSweep.ts` (our extraction predated the fixes) |
| `feed_state <> 'removed'` on dedupe | `bank/bankBulkCommitDedupe.ts` |
| `feed_state = 'posted'` candidate fence | `bank/bankTransferLinkService` candidates, `bank/bankAllocationControl.ts` (`assertPostedForAllocation`) |
| `isBankSubtype` + `feed_state <> 'removed'` on delete | `gl/glAccountUpdateService.ts` |
| Once-off closed at the **line's own** month end; overlap-based supersede predicate | `controls/payrollCompensationExpand.ts` |
| SDL on twelve months of employer remuneration; `applyRunLoans` diff | `payroll/payrollCalculationService.ts` |
| Declaration claimed before posting | `payroll/uifPaymentService.ts` (our `source: 'manual'` change carried with it) |
| `selectableTxIds` / `allSelected` gating | `useBankTransactionsController.ts`, `BankTransactionsView.tsx` |

Two findings worth recording:

- **`core/paymentVoidService.ts`** — our branch had **inverted** the lock order (payment before bank
  line). Master's reordering was therefore a live deadlock defect on this branch, not a redundant
  fix. Now: peek journal unlocked → lock bank transaction → lock payment, with typed
  `PaymentPostedDuringVoidError`, all inside our control wrapper.
- **`gl/journalEntryPostingService.ts`** — the contra INSERT now LEFT JOINs `projects` /
  `cost_centres` / `business_units` so an unowned dimension is **dropped**, returned as
  `foreignDimensionDroppedLines`. Our raw line copy would have hit migration 664's composite FK and
  bricked reversals — the exact defect master's `2eff04c92` fixed.

**Git produced non-compiling code OUTSIDE any conflict marker** in
`ar/customerPaymentAllocationService.ts` (`parentControl` used but not threaded). Auto-merged
regions were not automatically safe in this merge.

---

## 3. Files where judgement was required

**`gl/yearEndCloseService.ts` + `gl/controlledYearEnd.ts`.** Master rewrote the result contract
(`periodsLockedInYear`, `alreadyClosed`, `unclosedNetIncome`; a dry-run union with `preview: null` +
`residualPreview`; three new refusals) into `yearEndCloseTypes.ts`. Our side had replaced the close
with a controlled writer whose already-closed detection read **only `control_operation_effects`** —
so a year closed *before this programme existed* has no receipt, and our path would have written a
second `YE-<year>` journal and died on `uq_gl_je_company_entry_number` as a raw 23505. Resolved by
keeping the controlled writer and giving it master's contract **and** master's ledger-based
`findClosingJournal` / `classifyClosingJournal` / `alreadyClosedResult`, with the receipt replay
still running first. Placed after the open-periods check and before the locked-periods throw,
because a closed year's periods read `locked`. **Residual: DECISION 1** (below).

**`bank/bankAllocationService.ts`** (largest conflict, ~628 lines). Ours taken whole, only after
verifying each master fix survives inside the kernel: R-067's customer fence → `bankAllocationSources`
reads the party `FOR SHARE` and refuses `Owned allocation party required` for **customer and
supplier** (closing R-068, which master left open); `status <> 'imported'` → `bankAllocationControl`;
cc1/cc2/bu → `bankAllocationDimensions`. The feed-state guard was genuinely absent and was ported.

**`core/sageImportService.ts`.** Master's conversion of `importLedgerTransactions` away from
INSERT-at-posted **predates the merge base**, so nothing was at risk. Our path subsumes it:
`controls/historicalImportExecution.ts:76-82` inserts at `status='draft'`, `source='auto_gl_import'`,
registers the generated journal, then calls `postJournalEntry` — the canonical gate plus permit,
receipt and evidence binding.

**`scripts/ci/check-vat-guard-coverage.ts`.** Master restructured the allowlist and added a
`beyondEntry` failure class; we had deleted the `bank-transactions-action.ts` entry because that
route no longer calls `allocateTransaction`. Kept master's restructure **minus** that entry — a
stale entry *fails* the gate.

**Module docs (10 files: 5 `.claude.md` + 5 `AGENTS.md`).** The `.claude.md` files merged by
**union** — a dropped rule here means a future agent breaks an invariant it was never told about.
Master's `bank/.claude.md` deliberately compressed pre-09-11 history into a `## Provenance`
section, so our older bullets were not re-added. The 5 `AGENTS.md` are **generated mirrors** and
were regenerated with `bun run agent-docs:generate`, never hand-edited.

---

## 4. Tests (32 conflicted)

Resolved against the production code as it actually ended up, not as either side assumed. Both
sides' cases kept wherever both still described real behaviour; cases pinning a vanished seam were
deleted with the lost coverage named. **No assertion was weakened to make a test pass.**

`tests/unit/components/yearEndCloseMessage.test.tsx` was added independently on **both** sides with
no merge base; the two sets of cases were combined into one file on our harness (master's module
mock supplied only `apiFetch`, leaving `assertOk` — the half under test — undefined).

Conflicted test files: `lib/billing/withFlowMeter`, `mcp/fiscalPeriodTools`, `components/yearEndCloseMessage`,
`services/{ap/batchPaymentService, ar/receiptApplicationService, capture/provisionalPostingService,
customerPaymentService, dualDepreciationAtomicity, glEntrySourceConstraint, journalEntryReversalDate,
p21InputValidation, paymentVoidService, supplierPaymentVoid, supplierPaymentWorkflowService,
yearEndService, bankAllocationBatchStamp, bankAllocationService, bankAllocationSign}`,
`services/bank/{autoPostGateService, autoPostUndoService, bankAllocationDateShift, bankAllocationUnwind,
bankRuleSupplierDocument, supplierBankLineDocument}`, `services/gl/{journalEntryReversal,
yearEndCloseDryRun, yearEndInsertColumnsDb, yearEndRetainedEarnings}`,
`services/payroll/{payPackageService, payrollBatchService, payrollEmployeeComponentService}`.

### The 8 delete/modify files — all KEEP DELETED, each on its own evidence

Our branch deleted these (`a23d5a0d0`, `34d3a6031`, `9c259b89c` — spies on writers the kernel
replaced, coverage moved to `tests/integration/controls/`); master modified them in the same window.
Checked commit by commit:

| File | Master's change | Verdict |
|---|---|---|
| `bankAllocationBatchStamp`, `bankAllocationService`, `bankAllocationSign`, `bank/bankAllocationDateShift`, `bank/supplierBankLineDocument` | fixture/mock plumbing only (`feed_state: 'posted'`, a `withSavepoint` passthrough) | Keep deleted. Real pins survive: `bank/bankFeedStateGuard.test.ts`, `customerOwnershipFence.test.ts` |
| `bank/bankRuleSupplierDocument` | **real pin**: `autoPostRuleLine` → `{kind:'raced'}` for a pending feed row | Keep deleted — **coverage LOST**, re-pin in `bankRulesAutoPostOutcomes.test.ts` |
| `gl/journalEntryReversal` | 3 pins; 2 live, 1 inapplicable | Keep deleted — VAT-classification-on-contra **LOST**, re-pin in `gl39Reversal.int.test.ts`. Foreign-dimension drop is pinned by `k051-reversal-foreign-dimension.int.test.ts` |
| `journalEntryReversalPeriod` | mock plumbing | Keep deleted — its assertion (`fiscalPeriodId` must be undefined) is now the **opposite** of intended behaviour |

---

## 5. Migrations

**`811_forensic_year_end_source.sql` deleted.** It defined `gl_journal_entries_source_check` with
the same 26 values as master's `627_gl_je_source_year_end.sql` but **without `NOT VALID`**, so after
the merge it was redundant and its removal avoids an ACCESS EXCLUSIVE validating scan of
`gl_journal_entries`. Both claims verified before deleting: nothing references it by name, and
`glEntrySourceConstraint.test.ts` resolves the owning migration by `parseInt(f, 10)`, so it now
pins master's 627 (6/6 passing).

No conflict resolution was needed for any other migration (filenames differ). Collision recheck
across every ref under `refs/heads` + `refs/remotes`: **no collisions** with 800–840 (40 files after
811's deletion) or anything else. The 7 duplicate prefixes (341–344, 434, 436, 437) are
**pre-existing on `origin/master`** and grandfathered by the audit as `OK (historical)`.

---

## 6. Was any controlled write removed or bypassed?

Checked by census, not by assurance.

Of the 99 conflicted files, 6 are byte-identical to master (§7). None writes `gl_journal_entries`,
`gl_journal_lines`, `customer_payments` or `supplier_payments` directly. The two on money paths
(`post-expense.ts`, `uifDeclarationService.ts`) reach the ledger only via
`createJournalEntry` / `postJournalEntry`, and `postJournalEntry` is `runJournalControl(...)` at
`gl/journalEntryPostingService.ts:51`.

Widened to every file the merge changed that is identical to master and writes those tables: 6 hits
(`migrationApService`, `gatewayInvoiceReceiptService`, `migrationImportService`, `softDeleteRowOps`,
`journalEntryCrudService`, `yearEndJournalPoster`). **None was a conflict** — our branch never
touched them, so no resolution chose master there. `journalEntryCrudService` is the crud layer
*under* the gate; `yearEndJournalPoster` now has zero production callers.

**Limit of this check:** it is a call-site and table census. It does not prove that a pre-existing
unconflicted bypass does not exist elsewhere in the tree.

---

## 7. Resolved by taking one side wholesale

Six conflicted files took **master** whole. Each is deliberate:

| File | Why |
|---|---|
| `src/lib/billing/withFlowMeter.ts` | Master had independently relocated `X-Flow-Refunded` into an `if (refundBalanceAfter !== null && !res.headersSent)` block carrying our exact reasoning verbatim. Our hunk was fully subsumed. |
| `pages/api/accounting/capture/[id]/post-expense.ts` | Master moved the petty-cash branch into `capture/pettyCashJournalService.ts` (300-line cap). Our `isPostingRefusal` swap must follow it there — **carry-forward, not yet done**: that file still catches `ClosedFiscalPeriodError`, so a lockdown refusal 500s instead of leaving a postable draft. |
| `pages/api/accounting/bank-feeds/[id]/extension-ingest.ts` | Master rewrote the route over `ingestBankBatch`. Our control intent survives **more strongly**: `bankIngestionService.suggest()` selects `auto_create_entry = false` rules only, so the extension path cannot auto-post at all — by construction rather than by our `{autoPost:false}` flag. |
| `src/modules/accounting/services/core/emailService.ts` | Both sides made the same fix independently (awaited + savepointed `logEmailAttempt`). Master's carries the fuller rationale. No control existed on our side here. |
| `src/modules/accounting/services/payroll/uifDeclarationService.ts` | Master moved the writer to `uifPaymentService.ts` and added a claim-before-post. Our one-line `source` change was carried into the new home. |
| `src/modules/accounting/types/gl.types.ts` | Only master's explanatory comment was in the conflicted hunk; both sides already carried `'year_end'`. |

Files taking **ours** whole did so only where master's fix was verified to survive elsewhere in the
kernel (`bankAllocationService`, `bankAllocationUnwind`, `duplicateMergeService`,
`depreciationRunPreview`) — each is evidenced above or in §3.

---

## 8. Open items (not this merge's to fix)

- **DECISION 1** — year-end lost master's 23505 race recovery; the INSERT is inside
  `executeControlledOperation`, so a caught conflict poisons the control transaction. Pinned by 6
  failures in `yearEndClosePostingGuard.test.ts`.
- **DECISION 2** — `autoPostUndoService.undoRow` calls the retired `unwindBankAllocationApplication`
  stub; undo of a hand-reversed row can never complete. Pinned by 2 failures. Design input in
  `2026-09-14-auto-post-undo-controlled-inverse.md`.
- **DECISION 3** — 26 raw `account_subtype` comparisons across 12 files; fails closed. Pinned by
  `bankCashSubtypeCensus.test.ts`.
- Carry-forward: `capture/pettyCashJournalService.ts` `isPostingRefusal` swap (§7).
- Re-pins owed: `autoPostRuleLine` `{kind:'raced'}`; VAT classification on a reversal contra.
- Dead after the merge: `gl/journalEntryPostingGuards.ts`, `gl/journalReversalDate.ts`,
  `core/sageLedgerRelinkGuard.ts`; `yearEndJournalPoster`'s `postClosingJournal` /
  `isClosingNumberConflict` / `lockYear` are kept alive only by tests.
- Control receipts written before this merge lack `periodsLockedInYear` / `alreadyClosed` /
  `unclosedNetIncome`, which `prior()` replays.

## Integration tests

**Not run.** The documented fixture's source dump (`/tmp/isaflow-remediation-schema-with-grants.sql`)
is gone, production `isaflow` is off-limits as a schema source, and the surviving forensic fixture
container predates master's migrations with no populated `schema_migrations` to say what to apply.
Applying ~100 migrations blind would have produced a fixture of unknown fidelity and failures nobody
could attribute. No coverage is implied. Only read-only `SELECT`s were issued against an existing
container; none was created or modified.
