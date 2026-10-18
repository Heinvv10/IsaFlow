/**
 * G-01 census, mechanised. Every file whose SQL SUMs gl_journal_lines must either leave out the
 * posted year-end closing journal through the ONE shared marker (`YEAR_END_JOURNAL_SOURCE`,
 * gl/yearEndJournalSource.ts) or be listed below, reviewed, with the reason it is not a report
 * reader. A NEW reader nobody classified fails, so does a file that inlines the literal, and so
 * does an allow-list entry that has gone stale. docs/fixes/g01-census.md is the long form.
 *
 * A source-text ratchet, not a behaviour test: the behaviour is pinned by
 * tests/integration/g01-year-end-journal-excluded-from-reports.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const SVC = 'src/modules/accounting/services/';

const WRITE = 'write path: must SEE the close, or a re-run would close a closed year again';
const RAW = 'raw-ledger view or audit evidence: shows what is stored, the close included, by design';
const INTEGRITY = 'ledger integrity check over the raw ledger: a stored close is part of what it verifies';
const CASH = 'cash/bank accounts only: the close posts to revenue, expense and retained earnings';
const SUBLEDGER = 'sub-ledger, control-account or document check: not a P&L or equity figure';
const VAT = 'VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one)';
const MIGRATION = 'migration-time reconciliation against the source system, before any close exists';
const READINESS = 'pre-close readiness or draft listing: runs before the close';
const OPENING = 'opening-balance journals only (source opening_balance / auto_migration)';
const BANK = 'bank-feed matching and posting: reads one bank line\'s own journal';

const entries: Array<[string, string]> = [
  ['pages/api/accounting/journal-entries-audit.ts', RAW],
  ['pages/api/accounting/opening-balances-export.ts', OPENING],
  ['pages/api/accounting/reports-journal-entries.ts', RAW],
  ['pages/api/accounting/reports-waterfall.ts', CASH],
  ['afs/noteGenerators/primaryStatements/cashFlow.ts', CASH],
  ['ap/supplierCreditNoteExpenseLines.ts', SUBLEDGER],
  ['ar/invoiceRevenuePosting.ts', SUBLEDGER],
  ['audit/checks/journalRiskChecks.ts', RAW],
  ['audit/snapshotRows.ts', RAW],
  ['bank/agentActivityService.ts', BANK],
  ['bank/autoPostHandOffset.ts', BANK],
  ['bank/autoPostUndoProjection.ts', BANK],
  ['bank/bankCoverageDirections.ts', CASH],
  ['bank/bankReconciliationBalance.ts', CASH],
  ['bank/bankTxQueryFragments.ts', BANK],
  ['bank/cashBalanceService.ts', CASH],
  ['bank/splitJournalDocuments.ts', BANK],
  ['capture/capturedVatEvidence.ts', VAT],
  ['core/migrationExecuteService.ts', MIGRATION],
  ['core/migrationService.ts', MIGRATION],
  ['core/migrationSubtypeCheck.ts', MIGRATION],
  ['core/migrationValidationService.ts', MIGRATION],
  ['core/sageLedgerRelinkGuard.ts', MIGRATION],
  ['core/sageMigrationCompareService.ts', MIGRATION],
  ['dashboard/workbenchService.ts', VAT],
  ['gl/accountMergeFigures.ts', 'account-merge guard: counts and sums every posted line of the merged accounts'],
  ['gl/approvalDocuments.ts', 'approval digest of one journal\'s own debit total'],
  ['gl/auditTrailAttribution.ts', RAW],
  ['gl/auditTrailLedgerService.ts', RAW],
  ['gl/chartOfAccountsHealthService.ts', 'chart-of-accounts health: per-account stored balance and last posting'],
  ['gl/closeReadinessChecks/openingBalanceEquityCheck.ts', OPENING],
  ['gl/closeReadinessChecks/orphanPeriodJournalsCheck.ts', READINESS],
  ['gl/closeReadinessChecks/tbBalancedCheck.ts', READINESS],
  ['gl/closeRun/closeRunRepo.ts', READINESS],
  ['gl/controlAccountService.ts', SUBLEDGER],
  ['gl/glAccountBalance.ts', 'a single account\'s stored balance (chart of accounts, can-it-be-deleted guards)'],
  ['gl/integrityChecks/accountChecks.ts', INTEGRITY],
  ['gl/integrityChecks/bankChecks.ts', INTEGRITY],
  ['gl/integrityChecks/dimensionChecks.ts', INTEGRITY],
  ['gl/integrityChecks/documentChecks.ts', INTEGRITY],
  ['gl/integrityChecks/vatChecks.ts', INTEGRITY],
  ['gl/journalEntryListService.ts', RAW],
  ['gl/nonControlPostingAccounts.ts', SUBLEDGER],
  ['gl/openingBalanceReadService.ts', OPENING],
  ['gl/transactionLedgerService.ts', 'bank-account ledger plus the raw journal list'],
  ['gl/yearEndJournalBuilder.ts', WRITE],
  ['items/fixedAssetReconciliationQueries.ts', SUBLEDGER],
  ['reconciliation/creditNoteRelief.ts', SUBLEDGER],
  ['reconciliation/orphanControlPostings.ts', SUBLEDGER],
  ['reconciliation/unappliedPaymentCash.ts', SUBLEDGER],
  ['reconciliation/unpostedDocumentQueries.ts', SUBLEDGER],
  ['reports/cashFlowForecastDataService.ts', CASH],
  ['reports/glLineExportService.ts', 'GL line export: the raw ledger, close included (visible by design)'],
  ['reports/vat201NilRatedSupplies.ts', VAT],
  ['reports/vat201Service.ts', VAT],
  ['reports/vatAllocationMismatchService.ts', VAT],
  ['reports/vatControlMovement.ts', VAT],
  ['reports/vatExceptionsService.ts', VAT],
  ['reports/vatInputSupportQuery.ts', VAT],
  ['reports/vatLateClaimBasis.ts', VAT],
  ['reports/vatNonSupplyExceptions.ts', VAT],
  ['reports/vatReconciliationService.ts', VAT],
  ['reports/vatReturnService.ts', VAT],
  ['workbench/monthEndWorkbenchService.ts', READINESS],
];

const ALLOWED: Record<string, string> = Object.fromEntries(
  entries.map(([f, why]) => [f.startsWith('pages/') ? f : `${SVC}${f}`, why]),
);

const MARKER = /YEAR_END_JOURNAL_SOURCE/;
const SUMS_LINES = (src: string) => /gl_journal_lines/.test(src) && /SUM\(|sum\(/.test(src);

function files(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
}

describe('G-01: the year-end closing journal is excluded through one shared marker', () => {
  const all = files().map((f) => ({ f, src: readFileSync(resolve(ROOT, f), 'utf8') }));

  it('every ledger-summing reader uses the marker or is classified', () => {
    const readers = all.filter(({ src }) => SUMS_LINES(src));
    expect(readers.length).toBeGreaterThan(100);
    const unclassified = readers.filter(({ f, src }) => !MARKER.test(src) && !(f in ALLOWED)).map(({ f }) => f);
    expect(unclassified).toEqual([]);
  });

  it('no allow-list entry is stale (gone, no longer a reader, or now using the marker)', () => {
    const byFile = new Map(all.map(({ f, src }) => [f, src]));
    const stale = Object.keys(ALLOWED).filter((f) => {
      const src = byFile.get(f);
      return src === undefined || !SUMS_LINES(src) || MARKER.test(src);
    });
    expect(stale).toEqual([]);
  });

  it('nobody inlines the literal predicate again', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const inline = all
      .filter(({ f, src }) => !f.endsWith('yearEndJournalSource.ts') && /DISTINCT FROM 'year_end'/.test(code(src)))
      .map(({ f }) => f);
    expect(inline).toEqual([]);
  });
});
