/**
 * G-01 census, mechanised PER STATEMENT. Every SQL statement that reads gl_journal_lines or
 * gl_journal_entries and produces a figure must leave out the posted year-end closing journal
 * through the ONE shared marker (`je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}`,
 * gl/yearEndJournalSource.ts) inside ITS OWN SQL, or be classified below with a CATEGORY and the
 * category's one-line justification. The rule itself is tests/helpers/ledgerStatements.ts, which
 * also runs over PLANTED evasions further down.
 *
 * The first version counted one marker per FILE, so a marked statement vouched for every unmarked
 * one beside it. Now each template literal is read on its own (tests/helpers/templateLiterals.ts):
 * an import, a TS or SQL comment, or a sibling statement does not count. Figures aggregated in JS
 * are caught through the statement that feeds them (debit / credit / a line wildcard in its SELECT).
 * Templates that are not `sql`/`tx` statements (composed fragments, plain strings handed to a
 * runner) are listed separately, and so is any file that exposes `jl.debit`/`jl.credit` as a
 * report field. A CASH entry is verified, not trusted: every statement it covers must filter to
 * cash or bank accounts. docs/fixes/g01-census.md is the long form.
 *
 * A source-text ratchet, not a behaviour test: the behaviour is pinned by
 * tests/integration/g01-every-reader.int.test.ts and g01-year-end-journal-excluded-from-reports.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { templateLiterals } from '../../helpers/templateLiterals';
import {
  carriesMarker, isFigure, isSql, ledgerStatements, unmarkedFigureStatements, type Stmt,
} from '../../helpers/ledgerStatements';

const ROOT = resolve(__dirname, '../../..');
const SVC = 'src/modules/accounting/services/';

/** One line each: why a statement of this category is not a statement/report figure. */
const CATEGORIES = {
  WRITE: 'write path: must SEE the close, or a re-run would close a closed year again',
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
  RECLASS: 'reclassification candidates: the close stays in the universe and is a typed skip (is_year_end_close), never movable',
} as const;
type Category = keyof typeof CATEGORIES;

/** What a RECLASS statement must show: the close flagged on the row, for partition.ts to skip. */
const RECLASS_FLAG = /is_year_end_close/;

/** What a CASH statement must show: a restriction to cash / bank accounts. */
const CASH_FILTER = /CASH_SUBTYPES|BANK_SUBTYPES|bank_transactions|bank_account_id|account_subtype\s*=\s*'bank'/i;

/** [file under services/ (or pages/...), category, optional substring picking ONE statement]. */
const entries: Array<[string, Category, string?]> = [
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
  ['core/migrationExecuteService.ts', 'MIGRATION'],
  ['core/migrationService.ts', 'MIGRATION'],
  ['core/migrationSubtypeCheck.ts', 'MIGRATION'],
  ['core/migrationValidationService.ts', 'MIGRATION'],
  ['core/sageLedgerRelinkGuard.ts', 'MIGRATION'],
  ['core/sageMigrationCompareService.ts', 'MIGRATION'],
  ['dashboard/workbenchService.ts', 'VAT'],
  ['gl/accountMergeFigures.ts', 'GUARD'],
  ['gl/reclassification/candidates.ts', 'RECLASS'],
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
const COMPOSED: Array<[string, Category]> = [
  ['bank/bankTxQueryFragments.ts', 'BANK'],
  ['gl/dimensions/journalDimensionSetSql.ts', 'FRAGMENT'],
  ['gl/journalVatLockGuard.ts', 'VAT'],
  ['gl/vatLockLineClassification.ts', 'VAT'],
  ['payroll/payrollJournalChain.ts', 'SUBLEDGER'],
  ['reports/customReportFieldDefs.ts', 'RAW'],
  ['shared/journalInForceAsAt.ts', 'FRAGMENT'],
  ['shared/softDeleteLedgerPresence.ts', 'FRAGMENT'],
];

const key = (f: string) => (f.startsWith('pages/') ? f : `${SVC}${f}`);

function files(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
}

const sources = files().map((f) => ({ f, src: readFileSync(resolve(ROOT, f), 'utf8') }));
const statements: Stmt[] = sources.flatMap(({ f, src }) => ledgerStatements(f, src));
const figures = statements.filter(isFigure);

/** The entries that cover this statement: a whole-file entry, or one whose substring it contains. */
const covers = (s: Stmt) => entries.filter(([f, , m]) => key(f) === s.f && (m === undefined || s.body.includes(m)));

describe('G-01: the year-end closing journal is excluded through one shared marker, per statement', () => {
  it('finds the statements it is meant to police', () => {
    expect(figures.length).toBeGreaterThan(150);
    expect(figures.filter(carriesMarker).length).toBeGreaterThan(70);
  });

  it('every figure-producing statement carries the marker or is classified', () => {
    const unclassified = figures.filter((s) => !carriesMarker(s) && covers(s).length === 0)
      .map((s) => `${s.f}:${s.t.line}`);
    expect(unclassified).toEqual([]);
  });

  it('no allow-list entry is stale (it must cover at least one unmarked figure statement)', () => {
    const stale = entries.filter(([f, , m]) => !figures.some((s) =>
      !carriesMarker(s) && s.f === key(f) && (m === undefined || s.body.includes(m))))
      .map(([f, , m]) => (m ? `${f} (${m})` : f));
    expect(stale).toEqual([]);
  });

  it('every CASH entry is verified: each statement it covers filters to cash or bank accounts', () => {
    const offenders = figures.filter((s) => !carriesMarker(s)
      && covers(s).some(([, c]) => c === 'CASH') && !CASH_FILTER.test(s.body))
      .map((s) => `${s.f}:${s.t.line}`);
    expect(offenders).toEqual([]);
  });

  it('every RECLASS entry is verified: the statement flags the close so the partition can skip it', () => {
    const offenders = figures.filter((s) => !carriesMarker(s)
      && covers(s).some(([, c]) => c === 'RECLASS') && !RECLASS_FLAG.test(s.body))
      .map((s) => `${s.f}:${s.t.line}`);
    expect(offenders).toEqual([]);
  });

  it('every category used has its one-line justification, and none is unused', () => {
    const used = new Set<string>([...entries.map(([, c]) => c), ...COMPOSED.map(([, c]) => c)]);
    expect([...used].filter((c) => !(c in CATEGORIES))).toEqual([]);
    expect(Object.keys(CATEGORIES).filter((c) => !used.has(c))).toEqual([]);
  });

  it('a template that is not an sql/tx statement but names the journal tables is classified', () => {
    const composed = statements.filter((s) => !isSql(s)).map((s) => s.f);
    const unlisted = [...new Set(composed)].filter((f) => !COMPOSED.some(([c]) => key(c) === f));
    expect(unlisted).toEqual([]);
    const stale = COMPOSED.filter(([c]) => !composed.includes(key(c))).map(([c]) => c);
    expect(stale).toEqual([]);
  });

  it('a file that exposes jl.debit / jl.credit as a report field is a classified composer', () => {
    const exposing = sources
      .filter(({ src }) => /sqlExpr:\s*['"`][^'"`]*\b(?:jl|gjl)\.(?:debit|credit)/.test(src))
      .map(({ f }) => f);
    expect(exposing.length).toBeGreaterThan(0);
    expect(exposing.filter((f) => !COMPOSED.some(([c]) => key(c) === f))).toEqual([]);
  });

  it('nobody inlines the literal predicate again', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const inline = sources
      .filter(({ f, src }) => !f.endsWith('yearEndJournalSource.ts') && /DISTINCT FROM 'year_end'/.test(code(src)))
      .map(({ f }) => f);
    expect(inline).toEqual([]);
  });
});

describe('the rule catches planted evasions', () => {
  const MARK = 'AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}';
  const stmt = (body: string, tail = '') =>
    `import { YEAR_END_JOURNAL_SOURCE } from './x';\n// ${MARK}\nexport const q = (c: string) => sql\`${body} ${tail}\`;\n`;
  const FROM = 'FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE je.company_id = ${c}';
  const flagged = (src: string) => unmarkedFigureStatements('planted.ts', src).length;

  it('a marked statement passes and the same statement without the marker is flagged', () => {
    expect(flagged(stmt(`SELECT SUM(jl.debit) AS d ${FROM}`, MARK))).toBe(0);
    expect(flagged(stmt(`SELECT SUM(jl.debit) AS d ${FROM}`))).toBe(1);
  });

  it('SUM with a space, lower case and other aggregates are still figures', () => {
    expect(flagged(stmt(`SELECT SUM (jl.debit) AS d ${FROM}`))).toBe(1);
    expect(flagged(stmt(`select sum(jl.credit) as c ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT MAX (je.entry_date) AS d ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT array_agg(jl.debit) AS d ${FROM}`))).toBe(1);
  });

  it('listing line amounts for a TS-side reduce is a figure, wildcard included', () => {
    expect(flagged(stmt(`SELECT jl.debit, jl.credit ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT jl.* ${FROM}`))).toBe(1);
  });

  it('the marker in an import, a TS comment or a SQL comment does not vouch for the statement', () => {
    const inSqlComment = stmt(`SELECT SUM(jl.debit) AS d -- ${MARK}\n ${FROM}`);
    const inBlockComment = stmt(`SELECT SUM(jl.debit) AS d /* ${MARK} */ ${FROM}`);
    expect(flagged(inSqlComment)).toBe(1);
    expect(flagged(inBlockComment)).toBe(1);
  });

  it('a marked sibling statement does not vouch for an unmarked one in the same file', () => {
    const src = stmt(`SELECT SUM(jl.debit) AS d ${FROM}`, MARK) + stmt(`SELECT SUM(jl.credit) AS c ${FROM}`);
    expect(flagged(src)).toBe(1);
  });

  it('a nested statement is judged on its own, not by the statement that wraps it', () => {
    const src = 'export const q = (c: string, x: boolean) => sql`SELECT 1 ${x ? sql`SELECT SUM(jl.debit) AS d '
      + `${FROM}\` : sql\`SELECT 2\`} ${MARK}\`;\n`;
    expect(templateLiterals(src).length).toBe(3);
    expect(flagged(src)).toBe(1);
  });
});
