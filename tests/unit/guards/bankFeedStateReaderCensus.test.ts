/**
 * Bank sync v1 — feed_state reader census, mechanised.
 *
 * THIS IS A RATCHET (a source-text census), NOT A BEHAVIOUR TEST. It proves
 * nothing about what a query actually returns — only that every file whose
 * SQL reads `bank_transactions` (a `FROM bank_transactions` or
 * `JOIN bank_transactions`, anywhere in the file, multi-line included) has
 * been LOOKED AT and classified, once, in the map below. A new reader file
 * that nobody classified fails this test. It does not fail if someone
 * classifies a real gap as "exempt" for a bad reason — that is caught by
 * review, not by this mechanism. The behavioural proof that pending rows stay
 * hidden from totals and removed rows stay hidden from the queue lives in
 * tests/integration/bank-feed-pending-readers.int.test.ts.
 *
 * Classification values:
 *   'filtered'          — the file's bank_transactions reads that feed a
 *                          total/count/KPI/report scope by feed_state
 *                          ('posted' for totals, '<> removed' for the review
 *                          queue and queue-shaped lookups).
 *   'exempt: <reason>'  — reviewed and deliberately left unfiltered. Common
 *                          reasons: a writer path already gated by Task 2/3
 *                          (`assertFeedPosted` / the DB trigger from
 *                          migration 675), a column that only a posted row
 *                          can ever carry (`matched_journal_line_id`,
 *                          `reconciliation_id`, `provisional_je_id`,
 *                          `auto_post_run_id`), or a genuine non-financial
 *                          use (an FK/usage guard, an ownership check, a raw
 *                          data export, a row-count/size estimate).
 *
 * When this test fails on a new file: read what it does, add ONE line below,
 * classified honestly. Do not add '*' or a blanket reason — every entry
 * documents a specific file.
 *
 * EXTRA_FILES: a small allowlist of files classified explicitly even though
 * their SQL text does not literally match FROM/JOIN bank_transactions (e.g.
 * a table name that only appears in a runtime-built or LLM-generated query).
 * Round 2 finding C added the first one, nl-query.ts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/** Every tracked .ts/.tsx file under src/ and pages/, excluding tests. */
function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.startsWith('tests/'));
}

/** A file "reads" bank_transactions if its SQL text contains FROM/JOIN bank_transactions. */
const READS_BANK_TRANSACTIONS = /\b(FROM|JOIN)\s+bank_transactions\b/;

/**
 * Files classified explicitly even though the regex above does not match
 * them — e.g. dynamic/LLM-generated SQL where "bank_transactions" never
 * appears literally as a FROM/JOIN target in this file's own source text.
 * Round 2 finding C: nl-query.ts hands the LLM a schema hint naming the
 * table, and the actual SQL text is generated at request time, not present
 * here to grep. Listed here so it still gets a REAL classification instead
 * of silently falling outside the ratchet's reach.
 */
const EXTRA_FILES: readonly string[] = ['pages/api/accounting/nl-query.ts'];

/**
 * The classification map. One entry per file that reads bank_transactions —
 * see the header for what each value means. Built by reading every file in
 * Task 4 fix round 1 (findings item 6).
 */
const CLASSIFICATION: Readonly<Record<string, string>> = {
  'pages/api/accounting/anomaly-scan.ts': 'filtered',
  'pages/api/accounting/bank-accounts.ts': 'exempt: group-promotion usage guard, not a financial total',
  'pages/api/accounting/bank-feeds/[id]/extension-ingest.ts': 'exempt: writer (Task 3) — dedup pre-check inside the ingestion writer',
  'pages/api/accounting/bank-match-confirm.ts': 'exempt: writer (Task 3) — read-before-write plan phase',
  'pages/api/accounting/bank-reconciliation-report.ts': 'filtered',
  'pages/api/accounting/bank-rules-preview.ts': 'filtered',
  'pages/api/accounting/bank-transactions-bulk-commit.ts': 'exempt: writer (Task 3) — dedup pre-check inside the import writer',
  'pages/api/accounting/bank-transactions-bulk-preview.ts': 'exempt: writer (Task 3) — dedup pre-check inside the import writer',
  'pages/api/accounting/bank-transactions-import-classified.ts': 'exempt: writer (Task 3) — dedup pre-check inside the import writer',
  'pages/api/accounting/bank-tx-attachments.ts': 'exempt: attachment CRUD ownership check, not a financial total',
  'pages/api/accounting/dashboard-stats.ts': 'filtered',
  'pages/api/accounting/dashboard-todos.ts': 'filtered',
  'pages/api/accounting/nl-query.ts': "exempt: dynamic LLM SQL — schema hint instructs posted-only (feed_state added to the bank_transactions schema hint with an explicit 'must filter feed_state = posted' instruction; not enforced in this file's own static SQL text)",
  'pages/api/accounting/provisional/outstanding.ts': "exempt: non-posted rows cannot carry provisional_je_id (trigger 675)",
  'pages/api/accounting/reports/cash-movement.ts': 'filtered',
  'pages/api/accounting/setup-guide.ts': 'exempt: onboarding checklist presence flag, not a financial total',
  'pages/api/accounting/smart-categorize.ts': 'exempt: writer (Task 3) — read-before-write plan phase',
  'pages/api/landing-stats.ts': 'filtered',
  'src/modules/accounting/services/ap/supplierBankPaymentService.ts': 'exempt: writer (Task 3) — read-before-write plan phase',
  'src/modules/accounting/services/bank/autoPostGateService.ts': 'exempt: writer (Task 3) — the auto-post gate itself',
  'src/modules/accounting/services/bank/autoPostUndoService.ts': "exempt: non-posted rows cannot carry auto_post_run_id (trigger 675)",
  'src/modules/accounting/services/bank/bankAccountStatusService.ts': 'filtered',
  'src/modules/accounting/services/bank/bankAllocationBatchService.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675); writer-plan support",
  'src/modules/accounting/services/bank/bankAllocationRangeService.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/bank/bankAllocationService.ts': 'exempt: writer (Task 3) — write + post-write re-read',
  'src/modules/accounting/services/bank/bankAutoMatchService.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankCoverageDirections.ts': 'filtered',
  'src/modules/accounting/services/bank/bankCoverageQueries.ts': 'filtered',
  'src/modules/accounting/services/bank/bankFeedStateGuard.ts': 'exempt: writer (Task 3) — the feed_state guard primitive itself',
  'src/modules/accounting/services/bank/bankFeedSyncService.ts': 'exempt: writer (Task 3) — dedup pre-check inside the sync writer',
  'src/modules/accounting/services/bank/bankImportBatchQueryService.ts': "filtered (round 2: changed to feed_state <> 'removed' — a pending row is still linked to its import batch)",
  'src/modules/accounting/services/bank/bankImportService.ts': 'exempt: writer (Task 3) — import-time auto-post sweep candidate selection',
  'src/modules/accounting/services/bank/bankMatchDbQueries.ts': "exempt: writer (Task 3) plan-phase reads; matched_journal_line_id exclusion cannot carry it on a non-posted row (trigger 675)",
  'src/modules/accounting/services/bank/bankReconciliationCancelService.ts': "exempt: non-posted rows cannot carry reconciliation_id (trigger 675)",
  'src/modules/accounting/services/bank/bankReconciliationService.ts': 'filtered',
  'src/modules/accounting/services/bank/bankRulesMatchingHelpers.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankRulesMatchingService.ts': 'filtered',
  'src/modules/accounting/services/bank/bankRulesSuggestionPass.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankStatementDedupHelpers.ts': 'exempt: writer (Task 3) — dedup pre-check inside the import writer',
  'src/modules/accounting/services/bank/bankStatementImportService.ts': 'exempt: writer (Task 3) — dedup pre-check and post-commit status read',
  'src/modules/accounting/services/bank/bankTransactionLookupService.ts': "filtered (round 2: reference resolution excludes feed_state = 'removed' so a removed row cannot make a posted replacement look ambiguous; still a writer (Task 3) plan-phase lookup otherwise)",
  'src/modules/accounting/services/bank/bankTransactionQueryService.ts': 'filtered',
  'src/modules/accounting/services/bank/bankTransferAutoLink.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankTransferLinkService.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankTxAttachmentService.ts': 'exempt: attachment CRUD ownership check, not a financial total',
  'src/modules/accounting/services/bank/bankTxLock.ts': 'exempt: writer (Task 3) — row lock taken before a write',
  'src/modules/accounting/services/bank/bankTxQueryFragments.ts': 'exempt: shared SELECT fragment with no WHERE of its own; every caller (bankTransactionQueryService.ts) filters',
  'src/modules/accounting/services/bank/bankTxStatusMutations.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675); writer (Task 3)",
  'src/modules/accounting/services/bank/llmCategorizationPass.ts': 'exempt: writer (Task 3) — categorization pipeline reads/writes',
  'src/modules/accounting/services/capture/bankTxQueryReplyService.ts': 'exempt: writer (Task 3) — ownership preflight before a write',
  'src/modules/accounting/services/capture/bankTxQueryService.ts': 'exempt: writer (Task 3) send path; listing is an audit trail of already-created queries, not a financial total',
  'src/modules/accounting/services/capture/captureBankTxAttachService.ts': 'exempt: writer (Task 3) — ownership preflight before a write',
  'src/modules/accounting/services/capture/evidenceAttachmentService.ts': "exempt: non-posted rows cannot carry provisional_je_id (trigger 675)",
  'src/modules/accounting/services/capture/provisionalPostingService.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/core/archiveExecutionService.ts': "exempt: status='reconciled' is only reachable via a posted row's reconciliation workflow (trigger 675); writer",
  'src/modules/accounting/services/core/archiveQueryService.ts': 'exempt: archive row-inventory stats (row_count/oldest/newest), not a financial total',
  'src/modules/accounting/services/core/businessUnitService.ts': 'exempt: FK/usage guard before delete — must see every feed_state to prevent orphaned refs',
  'src/modules/accounting/services/core/costCentreUsageGuard.ts': 'exempt: FK/usage guard before delete/merge — must see every feed_state',
  'src/modules/accounting/services/core/documentQueryService.ts': 'filtered',
  'src/modules/accounting/services/core/globalSearchService.ts': 'filtered',
  'src/modules/accounting/services/core/paymentVoidService.ts': "exempt: status IN ('allocated','matched','reconciled') is only reachable via a posted row (Task 2/3 invariant)",
  'src/modules/accounting/services/core/smartCategorizationLearningService.ts': 'exempt: writer (Task 3) — learning pass write path',
  'src/modules/accounting/services/core/smartCategorizationMatchingService.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/core/smartCategorizationService.ts': 'exempt: writer (Task 3) — categorization apply write path',
  'src/modules/accounting/services/dashboard/workbenchService.ts': 'filtered',
  'src/modules/accounting/services/gl/accountMergeGuards.ts': 'exempt: FK/usage guard before merge — must see every feed_state',
  'src/modules/accounting/services/gl/accountReclassifyService.ts': 'exempt: FK/usage guard before reclassify — must see every feed_state',
  'src/modules/accounting/services/gl/chartOfAccountsService.ts': "filtered (round 2: soft-delete guard excludes feed_state = 'removed' — a removed feed row can no longer block deletion forever; pending rows still block, deliberately)",
  'src/modules/accounting/services/gl/closeReadinessChecks/bankReconciledCheck.ts': 'filtered',
  'src/modules/accounting/services/gl/continuousCloseQueryService.ts': 'filtered',
  'src/modules/accounting/services/gl/integrityChecks/bankChecks.ts':
    "filtered (duplicateBankReferences; staleSuggestedTransactions as of round 2 — its suggestion columns are NOT trigger-guarded, round 1 wrongly assumed they were); exempt: journalDateDiffersFromBankDate keys off matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/gl/integrityChecks/vatChecks.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/reports/cashFlowForecastDataService.ts': 'filtered',
  'src/modules/accounting/services/reports/consolidatedReportingService.ts': 'filtered',
  'src/modules/accounting/services/reports/customReportFieldDefs.ts': "filtered (the FROM clause text lives here in getBaseQuery; the predicate is applied by the sibling customReportRunner.ts's whereParts)",
  'src/modules/accounting/services/reports/kpiChartsService.ts': 'filtered',
  'src/modules/accounting/services/reports/kpiDashboardService.ts': 'filtered',
  'src/modules/accounting/services/reports/vatAllocationMismatchService.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/workbench/monthEndWorkbenchService.ts': 'filtered',
  'src/modules/admin/services/analyticsService.ts': 'exempt: platform-admin DB-size estimate, not a financial total',
  'src/modules/admin/services/dataExportService.ts': 'exempt: full company data export must include every row regardless of feed_state (completeness)',
  'src/modules/admin/services/sageMigrationOrchestrator.ts': 'exempt: writer (Task 3) — migration import writer',
  'src/modules/bureau/services/bureauWorkAggregatorService.ts': 'filtered',
};

describe('bank feed_state reader census (ratchet)', () => {
  it('classifies every file whose SQL reads bank_transactions', () => {
    const actual = sourceFiles().filter((f) => {
      const src = readFileSync(resolve(ROOT, f), 'utf8');
      return READS_BANK_TRANSACTIONS.test(src);
    });

    const expected = Object.keys(CLASSIFICATION);

    const unclassified = actual.filter((f) => !expected.includes(f));
    // A file in EXTRA_FILES is expected to be ABSENT from `actual` — that is
    // the whole reason it needed an explicit entry — so it must not count as
    // stale.
    const stale = expected.filter((f) => !actual.includes(f) && !EXTRA_FILES.includes(f));

    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });

    // Every EXTRA_FILES entry must actually be classified — otherwise the
    // tolerance above silently hides a typo'd or removed extra file.
    for (const f of EXTRA_FILES) {
      expect(expected, `EXTRA_FILES entry ${f} has no CLASSIFICATION`).toContain(f);
    }

    // Every classification is either exactly 'filtered' or starts with 'exempt: '
    // (or is the one mixed filtered+exempt entry, prefixed 'filtered').
    for (const [file, verdict] of Object.entries(CLASSIFICATION)) {
      const valid = verdict === 'filtered' || verdict.startsWith('filtered (') || verdict.startsWith('exempt: ');
      expect(valid, `${file}: "${verdict}" is not a valid classification`).toBe(true);
    }
  });
});
