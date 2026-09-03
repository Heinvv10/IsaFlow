/**
 * CaseWare Export Extension Service — AFS Plan 4 / Task γ.3
 * Bundles trial balance CSV + AFS metadata + account mappings into a CaseWare package.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import {
  exportCaseWareTB,
  getAccountMappings,
} from '@/modules/accounting/services/reports/casewareExportService';
import type { SectionStatus, SectionType, DocumentStatus, ReportingFramework } from './afsTypes';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

// ── Public types ──────────────────────────────────────────────────────────────

export interface CasewarePackageFile {
  name: string;
  content: string; // CSV or JSON string
  mimeType: string;
}

export interface CasewarePackage {
  files: CasewarePackageFile[];
  manifest: string; // CSV listing all files
}

// ── Internal shapes ───────────────────────────────────────────────────────────

interface AfsDocumentRow {
  fiscal_year: number | null;
  period: string | null;
  reporting_framework: ReportingFramework;
  status: DocumentStatus;
}

interface AfsSectionRow {
  section_type: SectionType;
  status: SectionStatus;
  sort_order: number;
}

interface AfsMetadata {
  documentId: string;
  fiscalYear: number | null;
  framework: ReportingFramework;
  status: DocumentStatus;
  sections: Array<{
    sectionType: SectionType;
    status: SectionStatus;
    sortOrder: number;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchDocumentRow(
  documentId: string,
  companyId: string,
): Promise<AfsDocumentRow> {
  const rows = await sql`
    SELECT fiscal_year, period, reporting_framework, status
    FROM afs_documents
    WHERE id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
  ` as DbRow[];

  const r = rows[0];
  if (r == null) {
    throw new Error(`AFS document not found: ${documentId}`);
  }

  return {
    fiscal_year: r.fiscal_year != null ? Number(r.fiscal_year) : null,
    period: r.period != null ? String(r.period) : null,
    reporting_framework: String(r.reporting_framework) as ReportingFramework,
    status: String(r.status) as DocumentStatus,
  };
}

async function fetchSectionRows(
  documentId: string,
  companyId: string,
): Promise<AfsSectionRow[]> {
  const rows = await sql`
    SELECT section_type, status, sort_order
    FROM afs_sections
    WHERE document_id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
    ORDER BY sort_order ASC
  ` as DbRow[];

  return rows.map((r: DbRow) => ({
    section_type: String(r.section_type) as SectionType,
    status: String(r.status) as SectionStatus,
    sort_order: Number(r.sort_order),
  }));
}

/**
 * The twelve months this CaseWare package covers.
 *
 * A third copy of the January-December assumption lived here — after
 * noteHelpers.fiscalRange and a private copy in reports/disclosureNoteGenerators
 * — so the exported trial balance covered the wrong year for every company
 * whose financial year does not start in January. It now resolves the same
 * fiscal calendar the statements use.
 *
 * Refuses when the document identifies no year at all. The previous fallback
 * was `new Date().getFullYear()`, which silently exported whichever year the
 * export happened to be run in.
 */
async function derivePeriod(
  doc: AfsDocumentRow,
  companyId: string,
): Promise<{ start: string; end: string }> {
  // `period` is stored as YYYY or YYYY-MM-DD; the year is what identifies it.
  const year = doc.period ? Number(doc.period.slice(0, 4)) : doc.fiscal_year;

  if (year == null || !Number.isFinite(Number(year))) {
    throw new Error(
      `derivePeriod: AFS document has neither a period nor a fiscal_year, so the ` +
      `year it covers is unknown. Refusing rather than exporting the current ` +
      `calendar year, which would put the wrong trading in a CaseWare package.`,
    );
  }

  return getFiscalRange(companyId, Number(year));
}

function buildManifest(files: CasewarePackageFile[]): string {
  const header = 'FileName,MimeType,Description';
  const descriptions: Record<string, string> = {
    'trial_balance.csv': 'Trial balance with CaseWare account codes',
    'afs_metadata.json': 'AFS document metadata and section status',
    'account_mappings.json': 'GL account to CaseWare code mappings',
  };
  const lines = files.map((f) => {
    const desc = descriptions[f.name] ?? f.name;
    return `${f.name},${f.mimeType},${desc}`;
  });
  return [header, ...lines].join('\r\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function buildFullCasewarePackage(
  documentId: string,
  companyId: string,
): Promise<CasewarePackage> {
  log.info(
    'Building full CaseWare package',
    { documentId, companyId },
    'casewareExportExtService',
  );

  // 1. Fetch document row for period derivation
  const docRow = await fetchDocumentRow(documentId, companyId);

  // 2. Trial balance CSV
  const { start, end } = await derivePeriod(docRow, companyId);
  const trialBalanceCsv = await exportCaseWareTB(companyId, start, end);

  // 3. AFS metadata JSON
  const sectionRows = await fetchSectionRows(documentId, companyId);
  const metadata: AfsMetadata = {
    documentId,
    fiscalYear: docRow.fiscal_year,
    framework: docRow.reporting_framework,
    status: docRow.status,
    sections: sectionRows.map((s) => ({
      sectionType: s.section_type,
      status: s.status,
      sortOrder: s.sort_order,
    })),
  };
  const metadataJson = JSON.stringify(metadata, null, 2);

  // 4. Account mappings JSON
  const accountMappings = await getAccountMappings(companyId, 'caseware');
  const accountMappingsJson = JSON.stringify(accountMappings, null, 2);

  // 5. Assemble package files
  const files: CasewarePackageFile[] = [
    { name: 'trial_balance.csv', content: trialBalanceCsv, mimeType: 'text/csv' },
    { name: 'afs_metadata.json', content: metadataJson, mimeType: 'application/json' },
    { name: 'account_mappings.json', content: accountMappingsJson, mimeType: 'application/json' },
  ];

  // 6. Manifest CSV
  const manifest = buildManifest(files);

  log.info(
    'CaseWare package assembled',
    { documentId, fileCount: files.length },
    'casewareExportExtService',
  );

  return { files, manifest };
}
