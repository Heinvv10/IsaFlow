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
  'pages/api/accounting/bank-match-confirm.ts': 'exempt: writer (Task 3) — read-before-write plan phase',
  'pages/api/accounting/bank-reconciliation-report.ts': 'filtered',
  'pages/api/accounting/bank-rules-preview.ts': 'filtered',
  'pages/api/accounting/bank-transactions-bulk-preview.ts': "filtered (final review A-16: the dedup hash set excludes feed_state = 'removed', same rule as bulk-commit)",
  'pages/api/accounting/bank-transactions-import-classified.ts': "filtered (final gate fix item 4: the dedup hash set excludes feed_state = 'removed', same rule as bulk-commit/bulk-preview); exempt: writer (Task 3) — dedup pre-check inside the import writer",
  'pages/api/accounting/bank-tx-attachments.ts': 'exempt: attachment CRUD ownership check, not a financial total',
  'pages/api/accounting/dashboard-stats.ts': 'filtered',
  'pages/api/accounting/dashboard-todos.ts': 'filtered',
  'pages/api/accounting/nl-query.ts': "filtered (final review A-15: bank lines are exposed to the LLM only as the bank_transactions_posted view from migration 675; the base table is off nlQueryValidationService's ALLOWED_TABLES, so generated SQL cannot read a pending/removed row)",
  'pages/api/accounting/provisional/outstanding.ts': "exempt: non-posted rows cannot carry provisional_je_id (trigger 675)",
  'pages/api/accounting/reports/cash-movement.ts': 'filtered',
  'pages/api/accounting/setup-guide.ts': 'exempt: onboarding checklist presence flag, not a financial total',
  'pages/api/accounting/smart-categorize.ts': 'exempt: writer (Task 3) — read-before-write plan phase',
  'pages/api/landing-stats.ts': 'filtered',
  'src/modules/accounting/services/bank/autoPostGateService.ts': 'exempt: writer (Task 3) — the auto-post gate itself',
  'src/modules/accounting/services/bank/autoPostHandCorrection.ts': "exempt: the only read is the run-close check `WHERE auto_post_run_id = …`. Trigger 675 refuses an UPDATE that tags a non-posted row and no writer INSERTs one with a run id (the 675 CHECK bank_tx_nonposted_unlinked omits that column — registered); if one ever existed the run would merely stay open. The line itself is read through the row lock (bankTxLock) — writer (Task 3)",
  'src/modules/accounting/services/bank/autoPostHandOffset.ts': "exempt: both reads look for another line OWNING a journal, keyed on provisional_je_id / matched_journal_line_id, which a non-posted row cannot carry (trigger 675); no total or queue scope",
  'src/modules/accounting/services/bank/autoPostUndoService.ts': "exempt: non-posted rows cannot carry auto_post_run_id (trigger 675)",
  'src/modules/accounting/services/bank/bankAccountStatusService.ts': 'filtered',
  // ── The controls-era bank allocation (the kernel's prepare/execute split).
  // `prepareBankAllocation` calls `assertPostedForAllocation` on the
  // materialised sources before it writes its intent, so every read below that
  // belongs to one of its phases is a writer read behind that refusal.
  'src/modules/accounting/services/bank/bankAllocationChildEffect.ts': 'exempt: writer (Task 3) — controlled allocation effect, id-keyed read behind prepare\'s feed refusal',
  'src/modules/accounting/services/bank/bankAllocationDefaultPreparation.ts': 'exempt: writer (Task 3) — id-keyed FOR UPDATE plan phase; prepareBankAllocation refuses a non-posted row',
  'src/modules/accounting/services/bank/bankAllocationLegacyProvisional.ts': 'exempt: keyed on provisional_je_id, which a non-posted row cannot carry (675 CHECK bank_tx_nonposted_unlinked)',
  'src/modules/accounting/services/bank/bankAllocationReversalMaterial.ts': 'exempt: writer (Task 3) — receipt material, id-keyed FOR SHARE on the intent\'s own bank row',
  'src/modules/accounting/services/bank/bankAllocationSources.ts': 'exempt: writer (Task 3) — this IS the read assertPostedForAllocation refuses on',
  'src/modules/accounting/services/bank/bankAllocationTransferEffect.ts': 'exempt: writer (Task 3) — occupancy keyed on matched_journal_line_id (675), then the transfer UPDATE',
  'src/modules/accounting/services/bank/bankAllocationTransferOriginal.ts': 'exempt: writer (Task 3) — id-keyed FOR UPDATE; occupancy keyed on matched_journal_line_id / transfer_journal_entry_id',
  'src/modules/accounting/services/bank/bankAllocationTransferSources.ts': "exempt: OPEN (master reconciliation 2026-09-14) — the opposite-leg candidate search is scoped by bank_account_id + amount + date window and status = 'imported' ONLY, so a PENDING row of the counterparty account can be offered as a transfer leg; it cannot be posted (trigger 675 refuses the UPDATE), so the exposure is a 500 where a 4xx belongs, not a wrong posting. Needs feed_state = 'posted' on that candidate query",
  'src/modules/accounting/services/bank/bankAllocationTransferState.ts': 'exempt: writer (Task 3) — id-keyed FOR UPDATE of the named transfer pair',
  'src/modules/accounting/services/bank/bankAllocationVatPreparation.ts': 'exempt: writer (Task 3) — id-keyed FOR UPDATE amount read inside the plan phase',
  // The dedup read that used to live in pages/api/accounting/bank-transactions-bulk-commit.ts.
  'src/modules/accounting/services/bank/bankBulkCommitDedupe.ts': "filtered (the dedup hash set excludes feed_state = 'removed' — same rule as bulk-commit/bulk-preview)",
  'src/modules/accounting/services/bank/bankControlActionService.ts': 'exempt: writer (Task 3) — id-keyed FOR UPDATE amount read and the post-write re-read of the row it just allocated',
  'src/modules/accounting/services/bank/bankControlReadService.ts': 'exempt: id-keyed single-row read of the line the caller names (its prepared operations), not a total or a queue scope',
  'src/modules/accounting/services/bank/bankTransferCandidateQueries.ts': 'exempt: both reads key on transfer_journal_entry_id / matched_journal_line_id — a non-posted row carries neither (675 CHECK, and every writer of the transfer column writes status too)',
  'src/modules/accounting/services/bank/bankTransferReadProvenance.ts': 'exempt: id-keyed provenance re-read of the named pair, plus occupancy keyed on matched_journal_line_id / transfer_journal_entry_id',
  'src/modules/accounting/services/controls/auditSnapshotCaptureQueries.ts': 'exempt: audit snapshot capture — the evidence archive must hold every row regardless of feed_state (completeness), same reason as the admin data export',
  'src/modules/accounting/services/controls/auditSnapshotEvidenceQuerySql.ts': 'exempt: id-joined evidence document lookup for rows already requested by id, not a total',
  'src/modules/accounting/services/controls/bankAttachmentEvidenceSource.ts': 'exempt: attachment ownership join (which company owns this attachment), not a financial total',
  'src/modules/accounting/services/controls/bankChildReversalGuard.ts': 'exempt: keyed on matched_journal_line_id, which a non-posted row cannot carry (675)',
  'src/modules/accounting/services/controls/bankStatementCompletenessQueries.ts': 'exempt: OPEN (master reconciliation 2026-09-14) — the attestation\'s uncovered/importedCount/importedNet/importedFingerprint scans count and SUM bank_transactions for a period with no feed_state predicate, so a pending row inflates the imported net a statement attestation is compared against. A bank statement shows posted lines only; this needs a decision from the controls owner before a predicate is added',
  'src/modules/accounting/services/controls/controlChangeHistoryParents.ts': 'exempt: id-keyed existence probe for the entity a change event names, not a total',
  'src/modules/accounting/services/controls/transactionEvidenceApprovals.ts': 'exempt: id-keyed existence probes binding an approval to its subject row, not a total',
  'src/modules/accounting/services/controls/transactionEvidenceDocumentLinks.ts': 'exempt: attachment-to-transaction relation graph for one named entity, not a total',
  'src/modules/accounting/services/controls/transactionEvidenceDocuments.ts': 'exempt: attachment ownership join for one named attachment, not a total',
  'src/modules/accounting/services/controls/transactionEvidenceQueries.ts': 'exempt: id-keyed status read of the entity the evidence request names, not a total',
  'src/modules/accounting/services/controls/transactionEvidenceRelations.ts': 'exempt: relation graph keyed on matched_journal_line_id / transfer_journal_entry_id — links a non-posted row cannot carry (675)',
  'src/modules/accounting/services/bank/bankAllocationBatchService.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675); writer-plan support",
  'src/modules/accounting/services/bank/bankAllocationRangeService.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/bank/bankAllocationService.ts': 'exempt: writer (Task 3) — write + post-write re-read',
  'src/modules/accounting/services/bank/bankAutoMatchService.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankCoverageDirections.ts': 'filtered',
  'src/modules/accounting/services/bank/bankCoverageQueries.ts': 'filtered',
  'src/modules/accounting/services/bank/bankFeedStateGuard.ts': 'exempt: writer (Task 3) — the feed_state guard primitive itself',
  'src/modules/accounting/services/bank/bankImportBatchQueryService.ts': "filtered (round 2: changed to feed_state <> 'removed' — a pending row is still linked to its import batch)",
  'src/modules/accounting/services/bank/bankImportService.ts': 'exempt: writer (Task 3) — import-time auto-post sweep candidate selection',
  'src/modules/accounting/services/bank/bankMatchDbQueries.ts': "exempt: writer (Task 3) plan-phase reads; matched_journal_line_id exclusion cannot carry it on a non-posted row (trigger 675)",
  'src/modules/accounting/services/bank/bankReconciliationCancelService.ts': "exempt: non-posted rows cannot carry reconciliation_id (trigger 675)",
  'src/modules/accounting/services/bank/bankReconciliationService.ts': 'filtered',
  'src/modules/accounting/services/bank/bankRulesMatchingHelpers.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankRulesMatchingService.ts': 'filtered',
  'src/modules/accounting/services/bank/bankRulesSuggestionPass.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankStatementDedupHelpers.ts': "filtered (final gate fix item 4: the fingerprint index excludes feed_state = 'removed', same rule as bulk-commit/bulk-preview); exempt: writer (Task 3) — dedup pre-check inside the import writer",
  'src/modules/accounting/services/bank/bankStatementImportService.ts': "filtered (final review A-16: existingHashes excludes feed_state = 'removed'); exempt: post-commit status read is id-keyed on rows this import wrote",
  'src/modules/accounting/services/bank/bankTransactionLookupService.ts': "filtered (round 2: reference resolution excludes feed_state = 'removed' so a removed row cannot make a posted replacement look ambiguous; still a writer (Task 3) plan-phase lookup otherwise)",
  'src/modules/accounting/services/bank/bankTransactionQueryService.ts': 'filtered',
  'src/modules/accounting/services/bank/bankTransferAutoLink.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankTransferLinkService.ts': 'exempt: writer (Task 3)',
  'src/modules/accounting/services/bank/bankTxAttachmentService.ts': 'exempt: attachment CRUD ownership check, not a financial total',
  'src/modules/accounting/services/bank/bankTxLock.ts': 'exempt: writer (Task 3) — row lock taken before a write',
  'src/modules/accounting/services/bank/bankTxQueryFragments.ts': 'exempt: shared SELECT fragment with no WHERE of its own; every caller (bankTransactionQueryService.ts) filters',
  'src/modules/accounting/services/bank/bankTxStatusMutations.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675); writer (Task 3)",
  'src/modules/accounting/services/bank/feed/bankIngestionPersistence.ts': "exempt: the feed writer (Task 6) — the provider-id read is id-keyed and FOR UPDATE, and must see every state to apply the lifecycle; the content-hash read is the dedup set across all states by design (a pending/removed row still occupies its hash)",
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
  'src/modules/accounting/services/gl/closeReadinessChecks/bankReconciledCheck.ts': 'filtered',
  'src/modules/accounting/services/gl/continuousCloseQueryService.ts': 'filtered',
  // updateAccount/deleteAccount, and their bank-line guard, moved here out of chartOfAccountsService.ts.
  'src/modules/accounting/services/gl/glAccountUpdateService.ts': 'exempt: pre-change usage guard (may this bank GL account still be re-typed?) — like accountMergeGuards it must see every feed_state, and a pending row blocking the change is the conservative answer',
  'src/modules/accounting/services/gl/integrityChecks/bankChecks.ts':
    "filtered (duplicateBankReferences; staleSuggestedTransactions as of round 2 — its suggestion columns are NOT trigger-guarded, round 1 wrongly assumed they were); exempt: journalDateDiffersFromBankDate keys off matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/gl/integrityChecks/vatChecks.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/reports/cashFlowForecastDataService.ts': 'filtered',
  'src/modules/accounting/services/reports/consolidatedReportingService.ts': 'filtered',
  'src/modules/accounting/services/reports/customReportFieldDefs.ts': "filtered (the FROM clause text lives here in getBaseQuery; the predicate is applied by the sibling customReportRunner.ts's whereParts)",
  'src/modules/accounting/services/reports/kpiChartsService.ts': 'filtered',
  'src/modules/accounting/services/reports/kpiDashboardService.ts': 'filtered',
  'src/modules/accounting/services/reports/vatAllocationMismatchService.ts': "exempt: non-posted rows cannot carry matched_journal_line_id (trigger 675)",
  'src/modules/accounting/services/shared/cashApplicationBankOrigin.ts': 'exempt: writer (Task 3) — id-keyed FOR UPDATE re-read of the bank line the payment being inverted originated from',
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
