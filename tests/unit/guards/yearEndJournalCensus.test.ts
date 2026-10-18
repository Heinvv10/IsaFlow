/**
 * G-01 census, mechanised PER STATEMENT. Every SQL statement that reads gl_journal_lines or
 * gl_journal_entries and produces a figure (SUM / MAX / MIN / AVG, or debit/credit in its SELECT
 * list) must leave out the posted year-end closing journal through the ONE shared marker
 * (`je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}`, gl/yearEndJournalSource.ts), or be
 * classified below, reviewed, with the reason it is not a report reader.
 *
 * The first version counted one marker per FILE, so a marked statement vouched for every
 * unmarked one beside it. This version reads each template literal on its own
 * (tests/helpers/templateLiterals.ts) and a statement counts only its own marker.
 *
 * Also pinned: a template that is not an `sql`/`tx` statement (a composed fragment, a plain
 * string handed to a runner) must be listed; an allow-list entry that matches nothing is stale;
 * nobody inlines the literal. Figures aggregated in JS are covered because the SELECT-list rule
 * catches the statement that feeds them. docs/fixes/g01-census.md is the long form.
 *
 * A source-text ratchet, not a behaviour test: the behaviour is pinned by
 * tests/integration/g01-year-end-journal-excluded-from-reports.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { templateLiterals, type TemplateLiteral } from '../../helpers/templateLiterals';

const ROOT = resolve(__dirname, '../../..');
const SVC = 'src/modules/accounting/services/';

const WRITE = 'write path: must SEE the close, or a re-run would close a closed year again';
const RAW = 'raw-ledger view or audit evidence: shows what is stored, the close included, by design';
const INTEGRITY = 'ledger integrity check over the raw ledger: a stored close is part of what it verifies';
const CASH = 'cash/bank accounts only: the close posts to revenue, expense and retained earnings';
const SUBLEDGER = 'sub-ledger, control-account, payroll or document check: not a P&L or equity figure';
const VAT = 'VAT control accounts only: the close has no VAT line (journalVatLockGuard refuses one)';
const MIGRATION = 'migration-time reconciliation against the source system, before any close exists';
const READINESS = 'pre-close readiness or draft listing: runs before the close';
const OPENING = 'opening-balance journals only (source opening_balance / auto_migration)';
const BANK = "bank-feed matching and posting: reads one bank line's own journal";
const APPROVAL = "approval digest of one journal's own debit total";
const ACCOUNT_BALANCE = "a single account's stored balance (chart of accounts, can-it-be-deleted guards)";

/** [file under services/ (or pages/...), reason, optional substring picking ONE statement]. */
const entries: Array<[string, string, string?]> = [
  ['pages/api/accounting/dashboard-stats.ts', RAW + ' (the five most recent journals)', 'ORDER BY created_at DESC LIMIT 5'],
  ['pages/api/accounting/journal-entries-audit.ts', RAW],
  ['pages/api/accounting/opening-balances-export.ts', OPENING],
  ['pages/api/accounting/reports-journal-entries.ts', RAW],
  ['pages/api/accounting/reports-waterfall.ts', CASH],
  ['afs/cashFlowDirectService.ts', CASH],
  ['afs/noteGenerators/primaryStatements/cashFlow.ts', CASH],
  ['ap/supplierCreditNoteExpenseLines.ts', SUBLEDGER],
  ['ar/invoiceRevenuePosting.ts', SUBLEDGER],
  ['ar/unappliedReceiptOrigin.ts', SUBLEDGER],
  ['audit/checks/journalRiskChecks.ts', RAW],
  ['audit/snapshotRows.ts', RAW],
  ['bank/agentActivityService.ts', BANK],
  ['bank/autoPostHandOffset.ts', BANK],
  ['bank/autoPostUndoProjection.ts', BANK],
  ['bank/bankAutoMatchService.ts', BANK],
  ['bank/bankCoverageDirections.ts', CASH],
  ['bank/bankMatchDbQueries.ts', BANK],
  ['bank/bankReconciliationBalance.ts', CASH],
  ['bank/cashBalanceService.ts', CASH],
  ['bank/journalReversalState.ts', BANK],
  ['bank/splitJournalDocuments.ts', BANK],
  ['bank/transferDuplicateGuard.ts', BANK],
  ['capture/capturedVatEvidence.ts', VAT],
  ['core/anomalyScanService.ts', RAW],
  ['core/evidenceGraphService.ts', RAW],
  ['core/migrationExecuteService.ts', MIGRATION],
  ['core/migrationService.ts', MIGRATION],
  ['core/migrationSubtypeCheck.ts', MIGRATION],
  ['core/migrationValidationService.ts', MIGRATION],
  ['core/sageLedgerRelinkGuard.ts', MIGRATION],
  ['core/sageMigrationCompareService.ts', MIGRATION],
  ['dashboard/workbenchService.ts', VAT],
  ['gl/accountMergeFigures.ts', 'account-merge guard: counts and sums every posted line of the merged accounts'],
  ['gl/auditTrailAttribution.ts', RAW],
  ['gl/auditTrailLedgerService.ts', RAW],
  ['gl/chartOfAccountsHealthService.ts', 'chart-of-accounts health: per-account stored balance and last posting'],
  ['gl/closeReadinessChecks/openingBalanceEquityCheck.ts', OPENING],
  ['gl/closeReadinessChecks/orphanPeriodJournalsCheck.ts', READINESS],
  ['gl/closeReadinessChecks/tbBalancedCheck.ts', READINESS],
  ['gl/closeRun/closeRunRepo.ts', READINESS],
  ['gl/controlAccountService.ts', SUBLEDGER],
  ['gl/glIntegrityService.ts', INTEGRITY],
  ['gl/integrityChecks/accountChecks.ts', INTEGRITY],
  ['gl/integrityChecks/dimensionChecks.ts', INTEGRITY],
  ['gl/integrityChecks/documentChecks.ts', INTEGRITY],
  ['gl/integrityChecks/index.ts', INTEGRITY],
  ['gl/journalEntryListService.ts', RAW],
  ['gl/nonControlPostingAccounts.ts', SUBLEDGER],
  ['gl/openingBalanceReadService.ts', OPENING],
  ['gl/reclassification/candidates.ts', RAW],
  ['gl/transactionLedgerService.ts', 'bank-account ledger plus the raw journal list'],
  ['gl/vatLateClaimSplit.ts', VAT],
  ['gl/yearEndJournalBuilder.ts', WRITE],
  ['items/fixedAssetReconciliationQueries.ts', SUBLEDGER],
  ['payroll/payrollApprovalGate.ts', SUBLEDGER],
  ['payroll/payrollJournalChain.ts', SUBLEDGER],
  ['reconciliation/creditNoteRelief.ts', SUBLEDGER],
  ['reconciliation/orphanControlPostings.ts', SUBLEDGER],
  ['reconciliation/unappliedPaymentCash.ts', SUBLEDGER],
  ['reconciliation/unpostedDocumentQueries.ts', SUBLEDGER],
  ['reports/cashFlowForecastDataService.ts', CASH],
  ['reports/glLineExportService.ts', 'GL line export: the raw ledger, close included (visible by design)'],
  ['reports/vat201NilRatedSupplies.ts', VAT],
  ['reports/vat201Service.ts', VAT],
  ['reports/vatAllocationMismatchService.ts', VAT],
  ['reports/vatBalanceSheetExceptions.ts', VAT],
  ['reports/vatBoxBasisQuery.ts', VAT],
  ['reports/vatControlMovement.ts', VAT],
  ['reports/vatDeclaredElsewhereQuery.ts', VAT],
  ['reports/vatExceptionsService.ts', VAT],
  ['reports/vatInputSupportQuery.ts', VAT],
  ['reports/vatNonSupplyExceptions.ts', VAT],
  ['reports/vatReconciliationService.ts', VAT],
  ['reports/vatReturnService.ts', VAT],
  ['reports/vatUnpostedInvoices.ts', VAT],
  ['workbench/monthEndWorkbenchService.ts', READINESS],
  ['gl/approvalDocuments.ts', APPROVAL],
  ['gl/glAccountBalance.ts', ACCOUNT_BALANCE],
];

/** Templates that are not an sql/tx statement but still name the journal tables. */
const COMPOSED: Array<[string, string]> = [
  ['bank/bankTxQueryFragments.ts', BANK],
  ['gl/dimensions/journalDimensionSetSql.ts', 'dimension-set lateral: joins lines to their tags, no figure'],
  ['gl/journalVatLockGuard.ts', VAT],
  ['gl/vatLockLineClassification.ts', VAT],
  ['payroll/payrollJournalChain.ts', SUBLEDGER],
  ['reports/customReportFieldDefs.ts', 'custom report builder: user-chosen fields over the raw ledger, close included'],
  ['shared/journalInForceAsAt.ts', 'reversal-chain parity fragment: a join condition, no figure'],
  ['shared/softDeleteLedgerPresence.ts', 'reversal-chain presence fragment: a join condition, no figure'],
];

const key = (f: string) => (f.startsWith('pages/') ? f : `${SVC}${f}`);
const REF = /\b(?:FROM|JOIN)\s+gl_journal_(?:lines|entries)\b/i;
const FIGURE = /\b(?:SUM|MAX|MIN|AVG)\s*\(|\bSELECT\b[\s\S]*?\b(?:debit|credit)\b[\s\S]*?\bFROM\b/i;
const MARKER = /source IS DISTINCT FROM \$\{YEAR_END_JOURNAL_SOURCE\}/;
const stripSqlComments = (s: string) => s.replace(/--.*$/gm, '');

interface Stmt { f: string; t: TemplateLiteral; body: string }

function files(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
}

const sources = files().map((f) => ({ f, src: readFileSync(resolve(ROOT, f), 'utf8') }));
const statements: Stmt[] = sources
  .filter(({ src }) => src.includes('gl_journal_'))
  .flatMap(({ f, src }) => templateLiterals(src).map((t) => ({ f, t, body: stripSqlComments(t.text) })))
  .filter(({ body }) => REF.test(body));
const isSql = (s: Stmt) => s.t.tag === 'sql' || s.t.tag === 'tx';
const figures = statements.filter((s) => isSql(s) && FIGURE.test(s.body));

/** The entries that cover this statement: a whole-file entry, or one whose substring it contains. */
const covers = (s: Stmt) => entries.filter(([f, , m]) => key(f) === s.f && (m === undefined || s.body.includes(m)));

describe('G-01: the year-end closing journal is excluded through one shared marker, per statement', () => {
  it('finds the statements it is meant to police', () => {
    expect(figures.length).toBeGreaterThan(150);
    expect(figures.filter((s) => MARKER.test(s.body)).length).toBeGreaterThan(70);
  });

  it('every figure-producing statement carries the marker or is classified', () => {
    const unclassified = figures.filter((s) => !MARKER.test(s.body) && covers(s).length === 0)
      .map((s) => `${s.f}:${s.t.line}`);
    expect(unclassified).toEqual([]);
  });

  it('no allow-list entry is stale (it must cover at least one unmarked figure statement)', () => {
    const stale = entries.filter(([f, , m]) => !figures.some((s) =>
      !MARKER.test(s.body) && s.f === key(f) && (m === undefined || s.body.includes(m))))
      .map(([f, , m]) => (m ? `${f} (${m})` : f));
    expect(stale).toEqual([]);
  });

  it('a template that is not an sql/tx statement but names the journal tables is classified', () => {
    const composed = statements.filter((s) => !isSql(s)).map((s) => s.f);
    const unlisted = [...new Set(composed)].filter((f) => !COMPOSED.some(([c]) => key(c) === f));
    expect(unlisted).toEqual([]);
    const stale = COMPOSED.filter(([c]) => !composed.includes(key(c))).map(([c]) => c);
    expect(stale).toEqual([]);
  });

  it('the scanner pairs nested templates (a ternary of two statements is two statements)', () => {
    const src = 'const a = sql`SELECT 1 ${x ? sql`SELECT SUM(debit) FROM gl_journal_lines` : sql`SELECT 2`} END`;';
    const found = templateLiterals(src);
    expect(found.map((t) => t.tag)).toEqual(['sql', 'sql', 'sql']);
    expect(found.filter((t) => REF.test(t.text)).length).toBe(1);
  });

  it('nobody inlines the literal predicate again', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const inline = sources
      .filter(({ f, src }) => !f.endsWith('yearEndJournalSource.ts') && /DISTINCT FROM 'year_end'/.test(code(src)))
      .map(({ f }) => f);
    expect(inline).toEqual([]);
  });
});
