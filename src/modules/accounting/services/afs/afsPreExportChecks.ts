// src/modules/accounting/services/afs/afsPreExportChecks.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ReportingFramework, SectionStatus } from './afsTypes';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExportCheck {
  label: string;
  passed: boolean;
  severity: 'blocker' | 'warning';
  detail?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNumber(snapshot: Record<string, unknown>, key: string): number {
  const v = snapshot[key];
  return typeof v === 'number' ? v : 0;
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
  const assets      = getNumber(snap, 'totalAssets');
  const liabilities = getNumber(snap, 'totalLiabilities');
  const equity      = getNumber(snap, 'totalEquity');
  const diff        = Math.abs(assets - (liabilities + equity));

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

async function checkClosingCashEqualsBank(
  documentId: string,
  companyId: string,
): Promise<ExportCheck> {
  const label = 'Closing cash equals bank balance';

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

  const snap        = (rows[0].data_snapshot as Record<string, unknown>) ?? {};
  const closingCash = getNumber(snap, 'closingCash');
  const bankBalance = getNumber(snap, 'bankBalance');
  const diff        = Math.abs(closingCash - bankBalance);

  if (diff > 0.01) {
    return {
      label,
      passed: false,
      severity: 'blocker',
      detail: `Closing cash ${closingCash.toFixed(2)} does not match bank balance ${bankBalance.toFixed(2)}`,
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

  const [
    balanceSheet,
    closingCash,
    mandatoryNotes,
    comparativeFigures,
    allReviewed,
    imageResolution,
    directorsReport,
  ] = await Promise.all([
    checkBalanceSheetBalances(documentId, companyId),
    checkClosingCashEqualsBank(documentId, companyId),
    checkMandatoryNotes(documentId, companyId, reportingFramework),
    checkComparativeFigures(documentId, companyId),
    checkAllNotesReviewed(documentId, companyId),
    checkImageResolution(companyId),
    checkDirectorsReportApproved(documentId, companyId),
  ]);

  return [
    balanceSheet,
    closingCash,
    mandatoryNotes,
    comparativeFigures,
    allReviewed,
    imageResolution,
    directorsReport,
  ];
}
