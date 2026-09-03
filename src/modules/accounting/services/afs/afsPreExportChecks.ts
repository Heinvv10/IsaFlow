// src/modules/accounting/services/afs/afsPreExportChecks.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ReportingFramework, SectionStatus } from './afsTypes';
import { getFiscalRange } from './afsFiscalPeriod';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExportCheck {
  label: string;
  passed: boolean;
  severity: 'blocker' | 'warning';
  detail?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A figure from a section's stored snapshot, or null when it is not there.
 *
 * THIS RETURNING NULL RATHER THAN 0 IS THE POINT. It used to be:
 *
 *     return typeof v === 'number' ? v : 0;
 *
 * and both blocker checks read keys that no generator has ever written —
 * `totalAssets`/`totalLiabilities`/`totalEquity` against a snapshot holding
 * only `lines`, and `closingCash`/`bankBalance` against one holding `opening`
 * and `closing`. Every figure defaulted to 0, every difference was 0, and both
 * blockers passed on every document. A missing figure is now a FAILED blocker,
 * because a check that cannot see the number it is checking has not passed.
 */
function readNumber(snapshot: Record<string, unknown>, key: string): number | null {
  const v = snapshot[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// ── Blocker checks ────────────────────────────────────────────────────────────

async function checkBalanceSheetBalances(
  documentId: string,
  companyId: string,
): Promise<ExportCheck> {
  const label = 'Balance sheet balances';

  const rows = (await sql`
    SELECT data_snapshot
    FROM   afs_sections
    WHERE  document_id  = ${documentId}::UUID
      AND  company_id   = ${companyId}::UUID
      AND  section_type = 'statement_of_fp'
    LIMIT 1
  `) as Record<string, unknown>[];

  if (rows.length === 0 || rows[0] === undefined) {
    return { label, passed: false, severity: 'blocker', detail: 'Balance sheet section not found' };
  }

  const snap = (rows[0].data_snapshot as Record<string, unknown>) ?? {};
  const assets      = readNumber(snap, 'totalAssets');
  const liabilities = readNumber(snap, 'totalLiabilities');
  const equity      = readNumber(snap, 'totalEquity');

  const missing = (['totalAssets', 'totalLiabilities', 'totalEquity'] as const)
    .filter((k) => readNumber(snap, k) === null);
  if (missing.length > 0 || assets === null || liabilities === null || equity === null) {
    return {
      label,
      passed: false,
      severity: 'blocker',
      detail:
        `Balance sheet section holds no ${missing.join(', ')} — regenerate the section. ` +
        `The figures cannot be checked, so this check cannot pass.`,
    };
  }

  const diff = Math.abs(assets - (liabilities + equity));

  if (diff > 0.01) {
    return {
      label,
      passed: false,
      severity: 'blocker',
      detail: `Difference of ${diff.toFixed(2)} between assets and liabilities + equity`,
    };
  }

  return { label, passed: true, severity: 'blocker' };
}

/**
 * Closing cash on the cash flow statement must still equal the cash in the
 * ledger at period end.
 *
 * Compared against the LEDGER, not against the balance sheet's cash line. The
 * two statements use different definitions on purpose: the cash flow covers
 * cash and cash equivalents by subtype, while the balance sheet reports the
 * taxonomy lines a company has mapped, and a bank OVERDRAFT belongs in current
 * liabilities rather than in cash. Comparing them would block a correctly
 * prepared set of statements — a false blocker is as damaging as an absent one,
 * because it teaches an operator to reach for skipChecks.
 *
 * Against the ledger the check is meaningful at the moment that matters: the
 * snapshot was written when the section was generated, and any journal posted
 * since makes the statement stale. This is what catches that.
 */
async function checkClosingCashEqualsBank(
  documentId: string,
  companyId: string,
  periodEnd: string,
): Promise<ExportCheck> {
  const label = 'Closing cash agrees with the ledger';

  const rows = (await sql`
    SELECT data_snapshot
    FROM   afs_sections
    WHERE  document_id  = ${documentId}::UUID
      AND  company_id   = ${companyId}::UUID
      AND  section_type = 'cash_flow'
    LIMIT 1
  `) as Record<string, unknown>[];

  if (rows.length === 0 || rows[0] === undefined) {
    return { label, passed: false, severity: 'blocker', detail: 'Cash flow section not found' };
  }

  const snap = (rows[0].data_snapshot as Record<string, unknown>) ?? {};
  const closingCash = readNumber(snap, 'closingCash');

  if (closingCash === null) {
    return {
      label,
      passed: false,
      severity: 'blocker',
      detail:
        'The cash flow section holds no closing cash figure — regenerate it. ' +
        'The figure cannot be checked, so this check cannot pass.',
    };
  }

  const ledgerRows = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = ANY(${CASH_SUBTYPES as string[]})
      AND ga.account_type = 'asset'
      AND jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status     = 'posted'
      AND je.entry_date <= ${periodEnd}::date
  `) as Record<string, unknown>[];

  const ledgerCash = Number(ledgerRows[0]?.balance ?? 0);
  const diff = Math.abs(closingCash - ledgerCash);

  if (diff > 0.01) {
    return {
      label,
      passed: false,
      severity: 'blocker',
      detail:
        `The cash flow reports closing cash of ${closingCash.toFixed(2)} but the ledger holds ` +
        `${ledgerCash.toFixed(2)} at period end (difference ${diff.toFixed(2)}). ` +
        `Regenerate the cash flow section — journals have most likely been posted since it was built.`,
    };
  }

  return { label, passed: true, severity: 'blocker' };
}

async function checkMandatoryNotes(
  documentId: string,
  companyId: string,
  reportingFramework: ReportingFramework,
): Promise<ExportCheck> {
  const label = 'All mandatory notes present';

  // Mandatory templates for the document's framework or 'both'
  const templateRows = (await sql`
    SELECT section_type
    FROM   note_templates
    WHERE  is_mandatory = TRUE
      AND  (framework = ${reportingFramework} OR framework = 'both')
  `) as Record<string, unknown>[];

  if (templateRows.length === 0) {
    return { label, passed: true, severity: 'blocker' };
  }

  const mandatorySectionTypes = templateRows.map((r) => r.section_type as string);

  // Sections present for this document that are NOT pending
  const sectionRows = (await sql`
    SELECT section_type
    FROM   afs_sections
    WHERE  document_id = ${documentId}::UUID
      AND  company_id  = ${companyId}::UUID
      AND  status      != 'pending'
  `) as Record<string, unknown>[];

  const presentTypes = new Set(sectionRows.map((r) => r.section_type as string));
  const missing      = mandatorySectionTypes.filter((t) => !presentTypes.has(t));

  if (missing.length > 0) {
    return {
      label,
      passed: false,
      severity: 'blocker',
      detail: `Missing mandatory notes: ${missing.join(', ')}`,
    };
  }

  return { label, passed: true, severity: 'blocker' };
}


/**
 * Every general ledger account carrying a balance must reach the statements.
 *
 * THE DEFECT THIS CLOSES. Every statement query starts FROM afs_statement_lines
 * and joins to afs_account_mappings. An account nobody has mapped contributes
 * to no line, appears in no total, and produces no warning — it simply is not
 * in the financial statements. On the largest company that was 51% of the
 * ledger, R166.7m of R325.7m. Production currently holds ZERO rows in
 * afs_account_mappings, so today every company's statements are empty and
 * nothing said so.
 *
 * This is a tie-out, not a spot check: it compares the ledger against what the
 * mapping can see, and blocks the export on any variance. It needs no
 * generated sections, so it is meaningful even before a document is built, and
 * it clears itself the moment the mapping is complete.
 */
async function checkAllAccountsMapped(
  companyId: string,
  periodEnd: string,
): Promise<ExportCheck> {
  const label = 'Every ledger account reaches the statements';

  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE sl.code IS NULL AND bal.balance <> 0) AS unmapped_accounts,
      COALESCE(SUM(ABS(bal.balance)) FILTER (WHERE sl.code IS NULL), 0) AS unmapped_value,
      COALESCE(SUM(ABS(bal.balance)), 0)                                        AS total_value
    FROM (
      SELECT jl.gl_account_id AS id,
             SUM(jl.debit - jl.credit) AS balance
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND je.status     = 'posted'
        AND je.entry_date <= ${periodEnd}::date
      GROUP BY jl.gl_account_id
    ) bal
    LEFT JOIN afs_account_mappings am
      ON am.gl_account_id = bal.id
     AND am.company_id    = ${companyId}::UUID
    -- The mapping row is not enough. afs_account_mappings.afs_line_code is a
    -- bare varchar with NO foreign key to afs_statement_lines, so it can name
    -- a code that does not exist, or one since deactivated via
    -- toggleStatementLine. Either way the account reaches no line, no total
    -- and no statement — which is the whole defect this check exists to catch.
    -- Resolving the code is what makes this a tie-out rather than a row count.
    LEFT JOIN afs_statement_lines sl
      ON sl.company_id = ${companyId}::UUID
     AND sl.code       = am.afs_line_code
     AND sl.is_active
  `) as Record<string, unknown>[];

  const unmappedAccounts = Number(rows[0]?.unmapped_accounts ?? 0);
  const unmappedValue    = Number(rows[0]?.unmapped_value ?? 0);
  const totalValue       = Number(rows[0]?.total_value ?? 0);

  if (unmappedAccounts > 0) {
    const share = totalValue > 0 ? (unmappedValue / totalValue) * 100 : 0;
    return {
      label,
      passed: false,
      severity: 'blocker',
      detail:
        `${unmappedAccounts} general ledger account(s) holding ${unmappedValue.toFixed(2)} ` +
        `(${share.toFixed(1)}% of the ledger) do not resolve to an active AFS line, so they appear ` +
        `nowhere in these statements. Map them under AFS > Account Mapping before exporting.`,
    };
  }

  return { label, passed: true, severity: 'blocker' };
}

// ── Warning checks ────────────────────────────────────────────────────────────

const PRIMARY_STATEMENT_TYPES = ['statement_of_fp', 'income_statement', 'changes_in_equity', 'cash_flow'];

async function checkComparativeFigures(
  documentId: string,
  companyId: string,
): Promise<ExportCheck> {
  const label = 'Comparative figures present';

  const rows = (await sql`
    SELECT section_type, data_snapshot
    FROM   afs_sections
    WHERE  document_id  = ${documentId}::UUID
      AND  company_id   = ${companyId}::UUID
      AND  section_type = ANY(${PRIMARY_STATEMENT_TYPES})
  `) as Record<string, unknown>[];

  const missing = rows.filter((r) => {
    const snap = (r.data_snapshot as Record<string, unknown>) ?? {};
    return snap['priorYear'] == null;
  });

  if (missing.length > 0) {
    const types = missing.map((r) => r.section_type as string).join(', ');
    return {
      label,
      passed: false,
      severity: 'warning',
      detail: `No prior-year figures in: ${types}`,
    };
  }

  return { label, passed: true, severity: 'warning' };
}

async function checkAllNotesReviewed(
  documentId: string,
  companyId: string,
): Promise<ExportCheck> {
  const label = 'All notes reviewed';
  const reviewedStatuses: SectionStatus[] = ['reviewed', 'signed_off'];

  const rows = (await sql`
    SELECT status
    FROM   afs_sections
    WHERE  document_id = ${documentId}::UUID
      AND  company_id  = ${companyId}::UUID
      AND  status      != ANY(${reviewedStatuses})
  `) as Record<string, unknown>[];

  if (rows.length > 0) {
    return {
      label,
      passed: false,
      severity: 'warning',
      detail: `${rows.length} section(s) not yet reviewed`,
    };
  }

  return { label, passed: true, severity: 'warning' };
}

async function checkImageResolution(companyId: string): Promise<ExportCheck> {
  const label = 'Images below 150 DPI';

  const rows = (await sql`
    SELECT id
    FROM   afs_uploaded_images
    WHERE  company_id      = ${companyId}::UUID
      AND  low_res_warning = TRUE
  `) as Record<string, unknown>[];

  if (rows.length > 0) {
    return {
      label,
      passed: false,
      severity: 'warning',
      detail: `${rows.length} image(s) flagged as low resolution`,
    };
  }

  return { label, passed: true, severity: 'warning' };
}

async function checkDirectorsReportApproved(
  documentId: string,
  companyId: string,
): Promise<ExportCheck> {
  const label = "Director's Report approved";

  const rows = (await sql`
    SELECT status
    FROM   afs_sections
    WHERE  document_id  = ${documentId}::UUID
      AND  company_id   = ${companyId}::UUID
      AND  section_type = 'directors_report'
    LIMIT 1
  `) as Record<string, unknown>[];

  if (rows.length === 0 || rows[0] === undefined) {
    return {
      label,
      passed: false,
      severity: 'warning',
      detail: "Director's report section not found",
    };
  }

  const status = rows[0].status as string;
  if (status !== 'signed_off') {
    return {
      label,
      passed: false,
      severity: 'warning',
      detail: `Director's report status is '${status}', expected 'signed_off'`,
    };
  }

  return { label, passed: true, severity: 'warning' };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runPreExportChecks(
  documentId: string,
  companyId: string,
  reportingFramework: ReportingFramework,
): Promise<ExportCheck[]> {
  log.info('afsPreExportChecks.runPreExportChecks', { documentId, companyId });

  const docRows = (await sql`
    SELECT fiscal_year, document_type
    FROM   afs_documents
    WHERE  id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Record<string, unknown>[];

  const fiscalYear = docRows[0]?.fiscal_year;
  if (fiscalYear == null) {
    return [{
      label: 'Reporting period known',
      passed: false,
      severity: 'blocker',
      detail:
        'This document has no fiscal year, so the period it covers is unknown and none of ' +
        'its figures can be checked against the ledger.',
    }];
  }

  // getFiscalRange REFUSES an unusable companies.financial_year_start rather
  // than assuming March. That refusal is right, but letting it propagate turns
  // a misconfiguration into a 500 carrying an exception message — while the
  // same class of misconfiguration four lines above returns a readable blocker.
  // A pre-export check that crashes tells the accountant nothing about what to
  // fix.
  let periodEnd: string;
  try {
    ({ end: periodEnd } = await getFiscalRange(companyId, Number(fiscalYear)));
  } catch (err) {
    return [{
      label: 'Reporting period known',
      passed: false,
      severity: 'blocker',
      detail:
        `The financial year this company reports on is not set, so the period ` +
        `these statements cover cannot be determined. Set the financial year ` +
        `start under Settings > General. (${err instanceof Error ? err.message : String(err)})`,
    }];
  }

  // The mapping tie-out is about the ANNUAL FINANCIAL STATEMENTS, whose every
  // figure flows through afs_account_mappings. A management pack is a different
  // document type built from its own queries, so requiring a complete AFS
  // mapping would block pack delivery for a reason that does not apply to it.
  const isAfs = String(docRows[0]?.document_type ?? 'afs') === 'afs';

  const [
    allMapped,
    balanceSheet,
    closingCash,
    mandatoryNotes,
    comparativeFigures,
    allReviewed,
    imageResolution,
    directorsReport,
  ] = await Promise.all([
    isAfs
      ? checkAllAccountsMapped(companyId, periodEnd)
      : Promise.resolve<ExportCheck>({
          label: 'Every ledger account reaches the statements',
          passed: true,
          severity: 'blocker',
          detail: 'Not applicable to a management pack.',
        }),
    checkBalanceSheetBalances(documentId, companyId),
    checkClosingCashEqualsBank(documentId, companyId, periodEnd),
    checkMandatoryNotes(documentId, companyId, reportingFramework),
    checkComparativeFigures(documentId, companyId),
    checkAllNotesReviewed(documentId, companyId),
    checkImageResolution(companyId),
    checkDirectorsReportApproved(documentId, companyId),
  ]);

  return [
    allMapped,
    balanceSheet,
    closingCash,
    mandatoryNotes,
    comparativeFigures,
    allReviewed,
    imageResolution,
    directorsReport,
  ];
}
