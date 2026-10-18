# G-01 census: readers of `gl_journal_lines` / `gl_journal_entries`

Rule (Hein, option A): every REPORT or STATEMENT reader skips `source = 'year_end'` (both legs) through `YEAR_END_JOURNAL_SOURCE` (`gl/yearEndJournalSource.ts`), because the reporting layer DERIVES the close. The journal stays in the ledger as the lock and audit record and stays visible in raw-ledger views. Mechanised by `tests/unit/guards/yearEndJournalCensus.test.ts`; behaviour pinned by `tests/integration/g01-year-end-journal-excluded-from-reports.int.test.ts`.

Census by TABLE, not by grep count: 272 files in `src/` and `pages/` name `gl_journal_lines` or `gl_journal_entries`. 114 of them SUM ledger lines: 50 are report readers and are changed to exclude, 64 are not report readers (table 2). 1 more (`reports/postedThroughService.ts`, a MAX over created_at) excludes without a SUM. The other files read journal rows for status, linkage or posting guards and produce no balance or total (table 3). `scripts/` (one-off ops and seed scripts) is outside the product and not changed.

Why every reader, not only the P&L ones: the posted close credits the retained-earnings account. A balance-sheet or equity reader that kept it while the derived retained earnings (`calculateRetainedEarnings`, `getRetainedEarningsBroughtForward`) also counted the same profit would double count it, so the balance sheet, TB, equity bases, SOCE and AFS mappings skip the close on both legs. Reversed closes: `reverseJournalEntry` copies `source`, so a reversed close and its contra both carry `year_end` and drop out together; a re-close is a third `year_end` journal (`YE-<year>-R<n>`).

Write side, deliberately NOT excluded: `gl/yearEndJournalBuilder.ts` (`loadPLBalances`, `reloadNetIncome`) must see the close so a re-run reads the year as flat; `gl/yearEndJournalPoster.ts` / `gl/yearEndCloseService.ts` are the writers (G-06 changes below).

Raw-ledger views keep the close visible: journal list and detail (`journalEntryListService`, `reports-journal-entries`), GL line export, audit trail, integrity checks, audit snapshots, chart-of-accounts balances. The running-balance ledgers (account ledger, GL report/stream, account transactions) skip the close: their derived `Closed to retained earnings` row already shows it on revenue and expense accounts, and a stored retained-earnings balance in a ledger would not tie to the TB.

## 1. Statement / report readers: exclude

| file | what it produces | reads RE account directly? | action |
|---|---|---|---|
| `src/modules/accounting/services/gl/financialFiguresService.ts` | period P&L + cumulative balance-sheet figures (board pack, ratios, trends, MCP) | yes (equity subtypes, cumulative) | exclude |
| `src/modules/accounting/services/gl/trialBalanceService.ts` | trial balance rows + totals (TB page, CSV, MCP) | yes (all accounts) | exclude |
| `src/modules/accounting/services/gl/trialBalanceBasis.ts` | retained earnings brought forward (derived P&L before a date) | no (derives it) | exclude |
| `src/modules/accounting/services/gl/generalLedgerReportService.ts` | GL report: opening, movement, derived close per account | yes (any account) | exclude |
| `src/modules/accounting/services/gl/generalLedgerStreamService.ts` | streamed GL with running balance | yes (any account) | exclude |
| `src/modules/accounting/services/gl/accountTransactionsService.ts` | one account's transactions with opening/closing | yes (any account) | exclude |
| `src/modules/accounting/services/gl/reclassification/impact.ts` | reclassification before/after P&L bands | no | exclude |
| `src/modules/accounting/services/gl/yearEndService.ts` | year-end page: revenue/expense/net income per fiscal year | no | exclude |
| `src/modules/accounting/services/reports/incomeStatementService.ts` | income statement (page, export, comparative, by dimension) | no | exclude |
| `src/modules/accounting/services/reports/balanceSheetService.ts` | balance sheet, derived retained earnings, equity bases | yes (posted equity + derived) | exclude |
| `src/modules/accounting/services/reports/trendRowsService.ts` | 12-month account trends (P&L movement, balance-sheet balances) | yes (equity balances) | exclude |
| `src/modules/accounting/services/reports/dimensionPnlService.ts` | P&L by cost centre / business unit (MCP group_by) | no | exclude |
| `src/modules/accounting/services/reports/projectProfitabilityService.ts` | project / CC2 profitability + tagging coverage | no | exclude |
| `src/modules/accounting/services/reports/classificationCoverageService.ts` | classification coverage of P&L accounts | no | exclude |
| `src/modules/accounting/services/reports/accountLedgerService.ts` | account ledger drill-down (opening, rows, totals) | yes (any account) | exclude |
| `src/modules/accounting/services/reports/accountLedgerYearEnd.ts` | derived year-end close rows for the account ledger | no | exclude |
| `src/modules/accounting/services/reports/budgetVarianceService.ts` | actuals for budget vs actual (MCP, board pack) | no | exclude |
| `src/modules/accounting/services/reports/extendedRatioInputs.ts` | ratio inputs (scorecard, extended ratios) | no | exclude |
| `src/modules/accounting/services/reports/kpiDashboardService.ts` | KPI dashboard revenue/expense/journal count | no | exclude |
| `src/modules/accounting/services/reports/kpiChartsService.ts` | KPI charts: monthly revenue/expense, top expenses | no | exclude |
| `src/modules/accounting/services/reports/consolidatedStatementsService.ts` | group P&L, balance sheet, derived RE | yes (equity) | exclude |
| `src/modules/accounting/services/reports/consolidatedReportingService.ts` | group dashboard revenue/expense per company | no | exclude |
| `src/modules/accounting/services/reports/consolidatedTrialBalanceMembers.ts` | member trial balance for the consolidated TB | yes (all accounts) | exclude |
| `src/modules/accounting/services/reports/consolidationService.ts` | consolidation entity trial balance | yes (all accounts) | exclude |
| `src/modules/accounting/services/reports/casewareExportService.ts` | CaseWare TB export | yes (all accounts) | exclude |
| `src/modules/accounting/services/reports/disclosureNoteGenerators.ts` | disclosure notes: revenue, cash, VAT | no | exclude |
| `src/modules/accounting/services/reports/postedThroughService.ts` | posted_through stamp on every report | no | exclude |
| `src/modules/accounting/services/reports/unusualJournalsService.ts` | board pack page 11: unusual journals (system close is not user-keyed) | no | exclude |
| `src/modules/accounting/services/afs/afsKpiService.ts` | AFS KPIs: revenue, profit, equity, working capital | yes (total equity) | exclude |
| `src/modules/accounting/services/afs/afsMappingQueries.ts` | AFS mapped-account balances (current, prior), mapping coverage | yes (all accounts) | exclude |
| `src/modules/accounting/services/afs/afsPreExportChecks.ts` | AFS pre-export checks: cash tie, unmapped value | yes (all accounts) | exclude |
| `src/modules/accounting/services/afs/changesInEquityService.ts` | statement of changes in equity (opening, movements, closing) | yes (equity movements) | exclude |
| `src/modules/accounting/services/afs/managementPackGeneratorService.ts` | management pack revenue/profit/top lines | no | exclude |
| `src/modules/accounting/services/afs/pisCalculatorService.ts` | provisional / PIS turnover and liabilities tests | no | exclude |
| `src/modules/accounting/services/afs/noteGenerators/noteHelpers.ts` | AFS note balances by mapped line | yes (mapped equity lines) | exclude |
| `src/modules/accounting/services/afs/noteGenerators/notes1to5.ts` | AFS notes 1-5: provisions, intangibles | no | exclude |
| `src/modules/accounting/services/afs/noteGenerators/notes6to10.ts` | AFS notes 6-10: investments, inventory | no | exclude |
| `src/modules/accounting/services/afs/noteGenerators/notes11to15.ts` | AFS notes 11-15: cash, equity, loans, provisions | yes (equity note) | exclude |
| `src/modules/accounting/services/afs/noteGenerators/notes16to20.ts` | AFS notes 16-20: tax, revenue, other income, expenses | no | exclude |
| `src/modules/accounting/services/afs/noteGenerators/notes21to25.ts` | AFS notes 21-25: finance cost, employee cost, audit fees | no | exclude |
| `src/modules/accounting/services/afs/noteGenerators/notes26to30.ts` | AFS notes 26-30: subsequent events, result, debtors, creditors | no | exclude |
| `src/modules/accounting/services/afs/noteGenerators/primaryStatements/_helpers.ts` | AFS income statement / balance sheet / SOCE line amounts, opening accumulated income | yes (retained earnings) | exclude |
| `src/modules/accounting/services/packs/packTrendService.ts` | board pack monthly trend | no | exclude |
| `pages/api/accounting/reports-management-accounts.ts` | management accounts incl. cash flow deltas | no (non-RE equity) | exclude |
| `pages/api/accounting/dashboard-stats.ts` | dashboard revenue/expense and bank balances | no | exclude |
| `pages/api/accounting/reports-trend-analysis.ts` | trend analysis revenue/expense/cash | no | exclude |
| `pages/api/accounting/reports-cash-flow.ts` | cash flow statement (indirect) | no (non-RE equity) | exclude |
| `pages/api/accounting/cash-flow-export.ts` | cash flow export | no (non-RE equity) | exclude |
| `pages/api/accounting/reports-budget-vs-actual.ts` | budget vs actual page | no | exclude |
| `pages/api/accounting/budget-vs-actual-export.ts` | budget vs actual export | no | exclude |
| `src/modules/bureau/services/bureauClientMetricsService.ts` | bureau client revenue/expense/bank | no | exclude |

## 2. Sum ledger lines, not a statement: n/a (allow-listed in the guard test with the same reason)

| file | what it produces | reads RE account directly? | action |
|---|---|---|---|
| `pages/api/accounting/journal-entries-audit.ts` | sums ledger lines, not a statement figure | no | n/a: raw-ledger view or audit evidence: shows what is stored, the close included, by design |
| `pages/api/accounting/opening-balances-export.ts` | sums ledger lines, not a statement figure | no | n/a: opening-balance journals only (source opening_balance / auto_migration) |
| `pages/api/accounting/reports-journal-entries.ts` | sums ledger lines, not a statement figure | no | n/a: raw-ledger view or audit evidence: shows what is stored, the close included, by design |
| `pages/api/accounting/reports-waterfall.ts` | sums ledger lines, not a statement figure | no | n/a: cash/bank accounts only: the close posts to revenue, expense and retained earnings |
| `src/modules/accounting/services/afs/noteGenerators/primaryStatements/cashFlow.ts` | sums ledger lines, not a statement figure | no | n/a: cash/bank accounts only: the close posts to revenue, expense and retained earnings |
| `src/modules/accounting/services/ap/supplierCreditNoteExpenseLines.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/ar/invoiceRevenuePosting.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/audit/checks/journalRiskChecks.ts` | sums ledger lines, not a statement figure | no | n/a: raw-ledger view or audit evidence: shows what is stored, the close included, by design |
| `src/modules/accounting/services/audit/snapshotRows.ts` | sums ledger lines, not a statement figure | no | n/a: raw-ledger view or audit evidence: shows what is stored, the close included, by design |
| `src/modules/accounting/services/bank/agentActivityService.ts` | sums ledger lines, not a statement figure | no | n/a: bank-feed matching and posting: reads one bank line's own journal |
| `src/modules/accounting/services/bank/autoPostHandOffset.ts` | sums ledger lines, not a statement figure | no | n/a: bank-feed matching and posting: reads one bank line's own journal |
| `src/modules/accounting/services/bank/autoPostUndoProjection.ts` | sums ledger lines, not a statement figure | no | n/a: bank-feed matching and posting: reads one bank line's own journal |
| `src/modules/accounting/services/bank/bankCoverageDirections.ts` | sums ledger lines, not a statement figure | no | n/a: cash/bank accounts only: the close posts to revenue, expense and retained earnings |
| `src/modules/accounting/services/bank/bankReconciliationBalance.ts` | sums ledger lines, not a statement figure | no | n/a: cash/bank accounts only: the close posts to revenue, expense and retained earnings |
| `src/modules/accounting/services/bank/bankTxQueryFragments.ts` | sums ledger lines, not a statement figure | no | n/a: bank-feed matching and posting: reads one bank line's own journal |
| `src/modules/accounting/services/bank/cashBalanceService.ts` | sums ledger lines, not a statement figure | no | n/a: cash/bank accounts only: the close posts to revenue, expense and retained earnings |
| `src/modules/accounting/services/bank/splitJournalDocuments.ts` | sums ledger lines, not a statement figure | no | n/a: bank-feed matching and posting: reads one bank line's own journal |
| `src/modules/accounting/services/capture/capturedVatEvidence.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/core/migrationExecuteService.ts` | sums ledger lines, not a statement figure | no | n/a: migration-time reconciliation against the source system, before any close exists |
| `src/modules/accounting/services/core/migrationService.ts` | sums ledger lines, not a statement figure | no | n/a: migration-time reconciliation against the source system, before any close exists |
| `src/modules/accounting/services/core/migrationSubtypeCheck.ts` | sums ledger lines, not a statement figure | no | n/a: migration-time reconciliation against the source system, before any close exists |
| `src/modules/accounting/services/core/migrationValidationService.ts` | sums ledger lines, not a statement figure | no | n/a: migration-time reconciliation against the source system, before any close exists |
| `src/modules/accounting/services/core/sageLedgerRelinkGuard.ts` | sums ledger lines, not a statement figure | no | n/a: migration-time reconciliation against the source system, before any close exists |
| `src/modules/accounting/services/core/sageMigrationCompareService.ts` | sums ledger lines, not a statement figure | no | n/a: migration-time reconciliation against the source system, before any close exists |
| `src/modules/accounting/services/dashboard/workbenchService.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/gl/accountMergeFigures.ts` | sums ledger lines, not a statement figure | no | n/a: account-merge guard: counts and sums every posted line of the merged accounts |
| `src/modules/accounting/services/gl/approvalDocuments.ts` | sums ledger lines, not a statement figure | no | n/a: approval digest of one journal's own debit total |
| `src/modules/accounting/services/gl/auditTrailAttribution.ts` | sums ledger lines, not a statement figure | no | n/a: raw-ledger view or audit evidence: shows what is stored, the close included, by design |
| `src/modules/accounting/services/gl/auditTrailLedgerService.ts` | sums ledger lines, not a statement figure | no | n/a: raw-ledger view or audit evidence: shows what is stored, the close included, by design |
| `src/modules/accounting/services/gl/chartOfAccountsHealthService.ts` | sums ledger lines, not a statement figure | no | n/a: chart-of-accounts health: per-account stored balance and last posting |
| `src/modules/accounting/services/gl/closeReadinessChecks/openingBalanceEquityCheck.ts` | sums ledger lines, not a statement figure | no | n/a: opening-balance journals only (source opening_balance / auto_migration) |
| `src/modules/accounting/services/gl/closeReadinessChecks/orphanPeriodJournalsCheck.ts` | sums ledger lines, not a statement figure | no | n/a: pre-close readiness or draft listing: runs before the close |
| `src/modules/accounting/services/gl/closeReadinessChecks/tbBalancedCheck.ts` | sums ledger lines, not a statement figure | no | n/a: pre-close readiness or draft listing: runs before the close |
| `src/modules/accounting/services/gl/closeRun/closeRunRepo.ts` | sums ledger lines, not a statement figure | no | n/a: pre-close readiness or draft listing: runs before the close |
| `src/modules/accounting/services/gl/controlAccountService.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/gl/glAccountBalance.ts` | sums ledger lines, not a statement figure | no | n/a: a single account's stored balance (chart of accounts, can-it-be-deleted guards) |
| `src/modules/accounting/services/gl/integrityChecks/accountChecks.ts` | sums ledger lines, not a statement figure | no | n/a: ledger integrity check over the raw ledger: a stored close is part of what it verifies |
| `src/modules/accounting/services/gl/integrityChecks/bankChecks.ts` | sums ledger lines, not a statement figure | no | n/a: ledger integrity check over the raw ledger: a stored close is part of what it verifies |
| `src/modules/accounting/services/gl/integrityChecks/dimensionChecks.ts` | sums ledger lines, not a statement figure | no | n/a: ledger integrity check over the raw ledger: a stored close is part of what it verifies |
| `src/modules/accounting/services/gl/integrityChecks/documentChecks.ts` | sums ledger lines, not a statement figure | no | n/a: ledger integrity check over the raw ledger: a stored close is part of what it verifies |
| `src/modules/accounting/services/gl/integrityChecks/vatChecks.ts` | sums ledger lines, not a statement figure | no | n/a: ledger integrity check over the raw ledger: a stored close is part of what it verifies |
| `src/modules/accounting/services/gl/journalEntryListService.ts` | sums ledger lines, not a statement figure | no | n/a: raw-ledger view or audit evidence: shows what is stored, the close included, by design |
| `src/modules/accounting/services/gl/nonControlPostingAccounts.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/gl/openingBalanceReadService.ts` | sums ledger lines, not a statement figure | no | n/a: opening-balance journals only (source opening_balance / auto_migration) |
| `src/modules/accounting/services/gl/transactionLedgerService.ts` | sums ledger lines, not a statement figure | no | n/a: bank-account ledger plus the raw journal list |
| `src/modules/accounting/services/gl/yearEndJournalBuilder.ts` | sums ledger lines, not a statement figure | no | n/a: write path: must SEE the close, or a re-run would close a closed year again |
| `src/modules/accounting/services/items/fixedAssetReconciliationQueries.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/reconciliation/creditNoteRelief.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/reconciliation/orphanControlPostings.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/reconciliation/unappliedPaymentCash.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/reconciliation/unpostedDocumentQueries.ts` | sums ledger lines, not a statement figure | no | n/a: sub-ledger, control-account or document check: not a P&L or equity figure |
| `src/modules/accounting/services/reports/cashFlowForecastDataService.ts` | sums ledger lines, not a statement figure | no | n/a: cash/bank accounts only: the close posts to revenue, expense and retained earnings |
| `src/modules/accounting/services/reports/glLineExportService.ts` | sums ledger lines, not a statement figure | no | n/a: GL line export: the raw ledger, close included (visible by design) |
| `src/modules/accounting/services/reports/vat201NilRatedSupplies.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vat201Service.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vatAllocationMismatchService.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vatControlMovement.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vatExceptionsService.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vatInputSupportQuery.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vatLateClaimBasis.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vatNonSupplyExceptions.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vatReconciliationService.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/reports/vatReturnService.ts` | sums ledger lines, not a statement figure | no | n/a: VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one) |
| `src/modules/accounting/services/workbench/monthEndWorkbenchService.ts` | sums ledger lines, not a statement figure | no | n/a: pre-close readiness or draft listing: runs before the close |

## 3. Other readers (status, linkage, posting guards, document ownership): n/a, no balance or total

- **afs** (1): `afs/cashFlowDirectService.ts`
- **ap** (7): `ap/batchPaymentService.ts`, `ap/migrationApService.ts`, `ap/paymentJournalReversal.ts`, `ap/provisionalSettlementClaim.ts`, `ap/supplierInvoiceCancelPlan.ts`, `ap/supplierInvoiceDraftUpdateGuards.ts`, `ap/supplierPaymentWorkflowService.ts`
- **ar** (10): `ar/creditNoteApproveService.ts`, `ar/customerInvoiceCancelService.ts`, `ar/customerInvoiceGlPosting.ts`, `ar/customerInvoiceLock.ts`, `ar/customerInvoiceReadService.ts`, `ar/gatewayFeeService.ts`, `ar/gatewaySettledReceipt.ts`, `ar/portalChatbotService.ts`, `ar/unappliedReceiptOrigin.ts`, `ar/writeOffService.ts`
- **audit** (1): `audit/comparisonService.ts`
- **bank** (21): `bank/bankAllocationBatchService.ts`, `bank/bankAllocationRangeService.ts`, `bank/bankAllocationService.ts`, `bank/bankAutoMatchService.ts`, `bank/bankChainLineReversal.ts`, `bank/bankLineImporterGate.ts`, `bank/bankMatchDbQueries.ts`, `bank/bankReconciliationCancelService.ts`, `bank/bankReconciliationClaim.ts`, `bank/bankRuleAutoPostLine.ts`, `bank/bankTransferAutoLink.ts`, `bank/bankTransferLinkPasses.ts`, `bank/bankTransferLinkService.ts`, `bank/bankTxStatusMutations.ts`, `bank/chainBankLines.ts`, `bank/journalReversalState.ts`, `bank/provisionalDismissService.ts`, `bank/provisionalLineGuard.ts`, `bank/receiptToJournalService.ts`, `bank/reversalDatePostable.ts`, `bank/transferDuplicateGuard.ts`
- **capture** (5): `capture/capturePostingClaimRelease.ts`, `capture/captureRowLock.ts`, `capture/evidenceAttachmentService.ts`, `capture/provisionalEvidenceAttach.ts`, `capture/provisionalPostingService.ts`
- **core** (13): `core/anomalyScanService.ts`, `core/businessUnitService.ts`, `core/costCentreUsageGuard.ts`, `core/descriptionTemplateService.ts`, `core/evidenceGraphService.ts`, `core/globalSearchService.ts`, `core/migrationImportService.ts`, `core/migrationWizardOpeningBalanceService.ts`, `core/nlQueryFkPairs.ts`, `core/nlQueryValidationService.ts`, `core/paymentVoidReads.ts`, `core/sageMigrationService.ts`, `core/softDeleteJournalService.ts`
- **expense** (1): `expense/claimVatAdvice.ts`
- **gl** (48): `gl/accountMergeBillLines.ts`, `gl/accountMergeGuards.ts`, `gl/accountMergeInvoiceLines.ts`, `gl/accountMergeRecord.ts`, `gl/accountMergeReferences.ts`, `gl/accountMergeService.ts`, `gl/accountParentRules.ts`, `gl/approvalEnforcementPreview.ts`, `gl/assetDepreciationPosting.ts`, `gl/chartOfAccountsService.ts`, `gl/closeReadinessChecks/unpostedJournalsCheck.ts`, `gl/closeRun/closeRunProposalBuilder.ts`, `gl/continuousCloseQueryService.ts`, `gl/dimensions/dimensionBankSync.ts`, `gl/dimensions/dimensionTagApply.ts`, `gl/dimensions/dimensionTagPlan.ts`, `gl/dimensions/dimensionTypes.ts`, `gl/dimensions/journalDimensionSetSql.ts`, `gl/documentJournalClaimGuard.ts`, `gl/fiscalPeriodService.ts`, `gl/glCrossModuleHooks.ts`, `gl/glIntegrityService.ts`, `gl/headerAccountGuard.ts`, `gl/integrityChecks/index.ts`, `gl/isReportVisibleLeaf.ts`, `gl/journalDocumentLinkService.ts`, `gl/journalEntryCrudService.ts`, `gl/journalEntryMeta.ts`, `gl/journalEntryPostService.ts`, `gl/journalEntryPostingGuards.ts`, `gl/journalEntryPostingService.ts`, `gl/journalEntryReadService.ts`, `gl/journalEntryReversalClaim.ts`, `gl/journalLineOwnership.ts`, `gl/journalVatLockGuard.ts`, `gl/leafAccountValidator.ts`, `gl/manualJournalApproval.ts`, `gl/manualJournalAuthors.ts`, `gl/reclassification/batchService.ts`, `gl/reclassification/candidates.ts`, `gl/reclassification/journals.ts`, `gl/reclassification/lineLock.ts`, `gl/reclassification/partition.ts`, `gl/reclassification/planGuards.ts`, `gl/reclassification/post.ts`, `gl/reclassification/warnings.ts`, `gl/vatLateClaimSplit.ts`, `gl/vatLockLineClassification.ts`
- **items** (4): `items/adjustmentService.ts`, `items/depreciationRunQueries.ts`, `items/fixedAssetDisposalQueries.ts`, `items/fixedAssetReconciliationService.ts`
- **loans** (2): `loans/loanGlPostingService.ts`, `loans/loanService.ts`
- **pages/api** (12): `pages/accounting/sage-migration/index.tsx`, `ai-invoice-pipeline.ts`, `assets/[assetId]/gl-account.ts`, `bank-accounts.ts`, `bank-match-confirm.ts`, `bank-reconciliation-report.ts`, `bank-transfers.ts`, `intercompany-transactions.ts`, `month-end-close.ts`, `nl-query.ts`, `provisional/outstanding.ts`, `setup-guide.ts`
- **payroll** (3): `payroll/payrollApprovalGate.ts`, `payroll/payrollJournalChain.ts`, `payroll/payrollJournalPostingService.ts`
- **reports** (11): `reports/customReportFieldDefs.ts`, `reports/customReportRunner.ts`, `reports/groupCoaMappingService.ts`, `reports/vatAdjustmentService.ts`, `reports/vatBalanceSheetExceptions.ts`, `reports/vatBoxBasisQuery.ts`, `reports/vatDeclaredElsewhereQuery.ts`, `reports/vatEntryMembership.ts`, `reports/vatInputOverclaim.ts`, `reports/vatPeriodLockService.ts`, `reports/vatUnpostedInvoices.ts`
- **shared** (5): `shared/journalChainHead.ts`, `shared/journalInForceAsAt.ts`, `shared/journalPeriodVisibility.ts`, `shared/softDeleteLedgerPresence.ts`, `shared/unapplyRefusal.ts`
- **src** (12): `src/lib/mcp/postingAgent.ts`, `src/lib/mcp/toolIndex.ts`, `src/lib/mcp/tools/bulkAllocationPost.ts`, `src/lib/mcp/tools/reclassificationPropose.ts`, `src/lib/mcp/tools/writeCancelSupplierInvoice.ts`, `src/lib/mcp/tools/writeDimensionTags.ts`, `src/lib/mcp/tools/writePracticeTime.ts`, `src/lib/mcp/tools/writeReclassification.ts`, `src/modules/admin/services/analyticsService.ts`, `src/modules/admin/services/dataExportService.ts`, `src/modules/admin/services/sageMigrationCommitService.ts`, `src/modules/onboarding/services/paygEligibilityService.ts`

## 4. G-06 (same root): a reversed close

- `gl/yearEndJournalPoster.ts` `classifyClosingJournal`: a `year_end` row with `reversed_at` set is no longer "posted, so closed" (reversal keeps `status = 'posted'`).
- `gl/yearEndClosingNumber.ts` `findCurrentClosingJournal`: the close walks past reversed closes to the first free `YE-<year>-R<n>`, so the year can be closed again; a re-run after the re-close reports `alreadyClosed` against that journal.

