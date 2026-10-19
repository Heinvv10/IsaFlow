/**
 * The classification table behind tests/unit/guards/yearEndJournalCensus.test.ts: which ledger statements are
 * NOT report readers (and so are not made to carry the year-end marker), each with a CATEGORY and the
 * category's one-line justification. Kept apart so the guard file stays readable and under 300 lines.
 */
export const SVC = 'src/modules/accounting/services/';

/** One line each: why a statement of this category is not a statement/report figure. */
export const CATEGORIES = {
  WRITE: 'write path: must SEE the close, or a re-run would close a closed year again',
  RECONCILIATION: 'ledger-to-ledger reconciliation: the stored close is part of what the other ledger\'s balance reflects',
  RAW: 'raw-ledger view or audit evidence: shows what is stored, the close included, by design',
  INTEGRITY: 'ledger integrity check over the raw ledger: a stored close is part of what it verifies',
  CASH: 'cash/bank accounts only: the close posts to revenue, expense and retained earnings',
  SUBLEDGER: 'sub-ledger, control-account, payroll or document check: not a P&L or equity figure',
  VAT: 'VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one)',
  MIGRATION: 'migration-time reconciliation against the source system, before any close exists',
  READINESS: 'pre-close readiness or draft listing: runs before the close',
  OPENING: 'opening-balance journals only (source opening_balance / auto_migration)',
  BANK: "bank-feed matching and posting: reads one bank line's own journal",
  APPROVAL: "approval digest of one journal's own debit total",
  ACCOUNT_BALANCE: "a single account's stored balance (chart of accounts, can-it-be-deleted guards)",
  GUARD: 'write-time guard that counts every posted line of the accounts it protects',
  FRAGMENT: 'reversal-chain or dimension fragment: a join condition, no figure',
  PROSE: 'tool or UI description text that mentions the table; no query',
  TABLE_NAME: 'a table name in an allow/deny list or reference map; no query',
  CORRELATED: 'a scalar subselect over the lines of ONE entry that the enclosing query already filtered (correlated on its id)',
  CHAIN: 'reversal-chain walk to a journal\'s root: reads headers, no amounts',
  RECLASS: 'reclassification candidates: the close stays in the universe and is a typed skip (is_year_end_close), never movable',
} as const;
export type Category = keyof typeof CATEGORIES;

/** What a RECLASS statement must show: the close flagged on the row, for partition.ts to skip. */
export const RECLASS_FLAG = /is_year_end_close/;

/** What a CASH statement must show: a restriction to cash / bank accounts. */
export const CASH_FILTER = /CASH_SUBTYPES|BANK_SUBTYPES|bank_transactions|bank_account_id|account_subtype\s*=\s*'bank'/i;

/** [file under services/ (or pages/...), category, optional substring picking ONE statement]. */
export const entries: Array<[string, Category, string?]> = [
  ['pages/api/accounting/dashboard-stats.ts', 'RAW', 'ORDER BY created_at DESC LIMIT 5'],
  ['pages/api/accounting/journal-entries-audit.ts', 'RAW'],
  ['pages/api/accounting/opening-balances-export.ts', 'OPENING'],
  ['pages/api/accounting/reports-journal-entries.ts', 'RAW'],
  ['pages/api/accounting/reports-waterfall.ts', 'CASH'],
  ['afs/cashFlowDirectService.ts', 'CASH'],
  ['afs/noteGenerators/primaryStatements/cashFlow.ts', 'CASH'],
  ['ap/supplierCreditNoteExpenseLines.ts', 'SUBLEDGER'],
  ['ar/invoiceRevenuePosting.ts', 'SUBLEDGER'],
  ['ar/unappliedReceiptOrigin.ts', 'SUBLEDGER'],
  ['audit/checks/journalRiskChecks.ts', 'RAW'],
  ['audit/snapshotRows.ts', 'RAW'],
  ['bank/agentActivityService.ts', 'BANK'],
  ['bank/autoPostHandOffset.ts', 'BANK'],
  ['bank/autoPostUndoProjection.ts', 'BANK'],
  ['bank/bankAutoMatchService.ts', 'BANK'],
  ['bank/bankCoverageDirections.ts', 'CASH'],
  ['bank/bankMatchDbQueries.ts', 'BANK'],
  ['bank/bankReconciliationBalance.ts', 'BANK'],
  ['bank/cashBalanceService.ts', 'CASH'],
  ['bank/journalReversalState.ts', 'BANK'],
  ['bank/splitJournalDocuments.ts', 'BANK'],
  ['bank/transferDuplicateGuard.ts', 'BANK'],
  ['capture/capturedVatEvidence.ts', 'VAT'],
  ['core/anomalyScanService.ts', 'RAW'],
  ['core/evidenceGraphService.ts', 'RAW'],
  ['core/migrationExecuteService.ts', 'RECONCILIATION', 'FROM gl_accounts ga'],
  ['core/sageMigrationCompareService.ts', 'RECONCILIATION', 'FROM gl_accounts ga'],
  ['core/migrationService.ts', 'MIGRATION'],
  ['core/migrationSubtypeCheck.ts', 'MIGRATION'],
  ['core/migrationValidationService.ts', 'MIGRATION'],
  ['core/sageLedgerRelinkGuard.ts', 'MIGRATION'],
  ['dashboard/workbenchService.ts', 'VAT'],
  ['gl/accountMergeFigures.ts', 'GUARD'],
  ['gl/reclassification/candidates.ts', 'RECLASS'],
  ['afs/noteGenerators/notes26to30.ts', 'CORRELATED', 'SELECT COALESCE(SUM(l.debit)'],
  ['reports/unusualJournalsService.ts', 'CHAIN', 'SELECT r.id, r.reversal_of_id'],
  ['reports/unusualJournalsService.ts', 'CHAIN', 'SELECT p.id, p.reversal_of_id'],
  ['reports/unusualJournalsService.ts', 'BANK', 'array_agg(DISTINCT ABS(bt.amount))'],
  ['gl/auditTrailAttribution.ts', 'RAW'],
  ['gl/auditTrailLedgerService.ts', 'RAW'],
  ['gl/chartOfAccountsHealthService.ts', 'ACCOUNT_BALANCE'],
  ['gl/closeReadinessChecks/openingBalanceEquityCheck.ts', 'OPENING'],
  ['gl/closeReadinessChecks/orphanPeriodJournalsCheck.ts', 'READINESS'],
  ['gl/closeReadinessChecks/tbBalancedCheck.ts', 'READINESS'],
  ['gl/closeRun/closeRunRepo.ts', 'READINESS'],
  ['gl/controlAccountService.ts', 'SUBLEDGER'],
  ['gl/glIntegrityService.ts', 'INTEGRITY'],
  ['gl/integrityChecks/accountChecks.ts', 'INTEGRITY'],
  ['gl/integrityChecks/dimensionChecks.ts', 'INTEGRITY'],
  ['gl/integrityChecks/documentChecks.ts', 'INTEGRITY'],
  ['gl/integrityChecks/index.ts', 'INTEGRITY'],
  ['gl/journalEntryListService.ts', 'RAW'],
  ['gl/journalEntryReadService.ts', 'RAW'],
  ['gl/nonControlPostingAccounts.ts', 'SUBLEDGER'],
  ['gl/openingBalanceReadService.ts', 'OPENING'],
  ['gl/transactionLedgerService.ts', 'RAW'],
  ['gl/vatLateClaimSplit.ts', 'VAT'],
  ['gl/yearEndJournalBuilder.ts', 'WRITE'],
  ['items/fixedAssetReconciliationQueries.ts', 'SUBLEDGER'],
  ['payroll/payrollApprovalGate.ts', 'SUBLEDGER'],
  ['payroll/payrollJournalChain.ts', 'SUBLEDGER'],
  ['reconciliation/creditNoteRelief.ts', 'SUBLEDGER'],
  ['reconciliation/orphanControlPostings.ts', 'SUBLEDGER'],
  ['reconciliation/unappliedPaymentCash.ts', 'SUBLEDGER'],
  ['reconciliation/unpostedDocumentQueries.ts', 'SUBLEDGER'],
  ['reports/cashFlowForecastDataService.ts', 'CASH'],
  ['reports/glLineExportService.ts', 'RAW'],
  ['reports/vat201NilRatedSupplies.ts', 'VAT'],
  ['reports/vat201Service.ts', 'VAT'],
  ['reports/vatAllocationMismatchService.ts', 'VAT'],
  ['reports/vatBalanceSheetExceptions.ts', 'VAT'],
  ['reports/vatBoxBasisQuery.ts', 'VAT'],
  ['reports/vatControlMovement.ts', 'VAT'],
  ['reports/vatDeclaredElsewhereQuery.ts', 'VAT'],
  ['reports/vatExceptionsService.ts', 'VAT'],
  ['reports/vatInputSupportQuery.ts', 'VAT'],
  ['reports/vatNonSupplyExceptions.ts', 'VAT'],
  ['reports/vatReconciliationService.ts', 'VAT'],
  ['reports/vatReturnService.ts', 'VAT'],
  ['reports/vatUnpostedInvoices.ts', 'VAT'],
  ['workbench/monthEndWorkbenchService.ts', 'READINESS'],
  ['gl/approvalDocuments.ts', 'APPROVAL'],
  ['gl/glAccountBalance.ts', 'ACCOUNT_BALANCE'],
];

/** Templates that are not an sql/tx statement but still name the journal tables. */
export const COMPOSED: Array<[string, Category]> = [
  ['bank/bankTxQueryFragments.ts', 'BANK'],
  ['gl/dimensions/journalDimensionSetSql.ts', 'FRAGMENT'],
  ['gl/journalVatLockGuard.ts', 'VAT'],
  ['gl/vatLockLineClassification.ts', 'VAT'],
  ['payroll/payrollJournalChain.ts', 'SUBLEDGER'],
  ['reports/customReportFieldDefs.ts', 'RAW'],
  ['shared/journalInForceAsAt.ts', 'FRAGMENT'],
  ['shared/softDeleteLedgerPresence.ts', 'FRAGMENT'],
];

/** Quoted strings (not sql/tx templates) that name the journal tables: the cheap census for SQL that is not a tagged statement. */
export const STRINGS: Array<[string, Category]> = [
  ['pages/api/accounting/nl-query.ts', 'RAW'],
  ['lib/mcp/tools/reclassificationPropose.ts', 'PROSE'],
  ['lib/mcp/tools/writeDimensionTags.ts', 'PROSE'],
  ['ar/portalChatbotService.ts', 'TABLE_NAME'],
  ['core/nlQueryFkPairs.ts', 'TABLE_NAME'],
  ['core/nlQueryValidationService.ts', 'TABLE_NAME'],
  ['gl/accountMergeReferences.ts', 'TABLE_NAME'],
  ['gl/closeRun/closeRunProposalBuilder.ts', 'PROSE'],
];

export const key = (f: string) => (f.startsWith('pages/') ? f : f.startsWith('lib/') ? `src/${f}` : `${SVC}${f}`);
