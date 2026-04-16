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

function derivePeriod(doc: AfsDocumentRow): { start: string; end: string } {
  if (doc.period) {
    // period stored as YYYY or YYYY-MM-DD — normalise to full-year bounds
    const year = doc.period.slice(0, 4);
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  if (doc.fiscal_year != null) {
    return {
      start: `${doc.fiscal_year}-01-01`,
      end: `${doc.fiscal_year}-12-31`,
    };
  }
  const current = new Date().getFullYear();
  return { start: `${current}-01-01`, end: `${current}-12-31` };
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
  const { start, end } = derivePeriod(docRow);
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
