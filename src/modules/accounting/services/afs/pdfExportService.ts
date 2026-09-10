// src/modules/accounting/services/afs/pdfExportService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AfsDocument, BrandProfile, AfsSection, SectionType, SectionStatus, DocumentType, DocumentStatus, ReportingFramework, NoteContent, AfsSectionVersionEntry } from './afsTypes';
import { DEFAULT_BRAND_PROFILE, getBrandProfile } from './brandProfileService';
import { runPreExportChecks } from './afsPreExportChecks';
import { renderAfsToHtml } from './afsHtmlRendererService';
import { buildAfsCharts } from './serverChartSvg';
import { htmlToPdf } from './weasyprintService';
import { checkPublicUrl } from '@/lib/safeFetch';

export type { ExportCheck } from './afsPreExportChecks';
export { runPreExportChecks } from './afsPreExportChecks';

// ── Options ───────────────────────────────────────────────────────────────────

export interface PdfExportOptions {
  watermark?: 'DRAFT — NOT FOR DISTRIBUTION';
  skipChecks?: boolean;
  /**
   * Render with the documented default branding when the company has saved none. The export
   * still refuses (a downloaded PDF should carry the firm's own branding), but signing uses it:
   * nothing creates a brand profile at company creation, so requiring one would leave most
   * companies permanently unable to send for signature.
   */
  allowDefaultBrandProfile?: boolean;
  /**
   * The company and brand values to render with, read and fingerprinted in one statement by the
   * caller (snapshotRenderInputs). When given, the renderer does NOT re-read those tables, so
   * the bytes it produces are exactly what the fingerprint describes. A null brand profile means
   * the snapshot saw none: the documented default is used.
   */
  inputs?: { companyName: string; registrationNumber: string | null; brandProfile: BrandProfile | null };
}

// ── DB row mappers ────────────────────────────────────────────────────────────

function mapDocumentRow(row: Record<string, unknown>): AfsDocument {
  return {
    id:                 row.id as string,
    companyId:          row.company_id as string,
    fiscalYear:         (row.fiscal_year as number | null) ?? null,
    period:             (row.period as string | null) ?? null,
    documentType:       row.document_type as DocumentType,
    signingRequestedAt: row.signing_requested_at instanceof Date ? row.signing_requested_at
                          : row.signing_requested_at != null ? new Date(row.signing_requested_at as string) : null,
    signingRefusedAt:   row.signing_refused_at instanceof Date ? row.signing_refused_at
                          : row.signing_refused_at != null ? new Date(row.signing_refused_at as string) : null,
    signingRefusedReason: (row.signing_refused_reason as string | null) ?? null,
    reportingFramework: row.reporting_framework as ReportingFramework,
    status:             row.status as DocumentStatus,
    lockedAt:           (row.locked_at as Date | null) ?? null,
    lockedBy:           (row.locked_by as string | null) ?? null,
    version:            row.version as number,
    pisScore:           (row.pis_score as number | null) ?? null,
    createdAt:          row.created_at as Date,
    updatedAt:          row.updated_at as Date,
  };
}

function mapSectionRow(row: Record<string, unknown>): AfsSection {
  return {
    id:                   row.id as string,
    documentId:           row.document_id as string,
    companyId:            row.company_id as string,
    sectionType:          row.section_type as SectionType,
    sortOrder:            row.sort_order as number,
    status:               row.status as SectionStatus,
    dataSnapshot:         (row.data_snapshot as Record<string, unknown> | null) ?? null,
    content:              (row.content as NoteContent | null) ?? null,
    overrides:            (row.overrides as Partial<NoteContent> | null) ?? null,
    aiNarrative:          (row.ai_narrative as string | null) ?? null,
    aiNarrativeAccepted:  Boolean(row.ai_narrative_accepted),
    reviewedBy:           (row.reviewed_by as string | null) ?? null,
    reviewedAt:           (row.reviewed_at as Date | null) ?? null,
    signedOffBy:          (row.signed_off_by as string | null) ?? null,
    signedOffAt:          (row.signed_off_at as Date | null) ?? null,
    versionHistory:       (row.version_history as AfsSectionVersionEntry[]) ?? [],
    createdAt:            row.created_at as Date,
    updatedAt:            row.updated_at as Date,
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

/**
 * Renders the statements to HTML. Every consumer — the PDF export and the signing request —
 * derives its bytes here. The document and its sections are read from their rows (in note
 * order, then id, so tied note numbers always print in one order); the company and branding
 * come either from their rows or, for signing, from the `inputs` the caller fingerprinted, so
 * what is signed is exactly what was fingerprinted.
 */
export async function renderDocumentHtml(
  documentId: string,
  companyId: string,
  options?: PdfExportOptions,
): Promise<string> {
  // 1. Load document
  const docRows = (await sql`
    SELECT *
    FROM   afs_documents
    WHERE  id         = ${documentId}::UUID
      AND  company_id = ${companyId}::UUID
  `) as Record<string, unknown>[];

  const docRow = docRows[0];
  if (docRow === undefined) {
    throw new Error(`Document not found: ${documentId}`);
  }
  const document = mapDocumentRow(docRow);

  // 2. Load sections
  const sectionRows = (await sql`
    SELECT *
    FROM   afs_sections
    WHERE  document_id = ${documentId}::UUID
      AND  company_id  = ${companyId}::UUID
    ORDER  BY sort_order ASC, id
  `) as Record<string, unknown>[];

  const sections = sectionRows.map(mapSectionRow);

  // 3. Load brand profile — unless the caller supplies the values it fingerprinted
  const savedProfile = options?.inputs ? options.inputs.brandProfile : await getBrandProfile(companyId);
  if (savedProfile === null && !options?.allowDefaultBrandProfile && !options?.inputs) {
    throw new Error(`Brand profile not found for company: ${companyId}`);
  }
  const brandProfile = savedProfile ?? { ...DEFAULT_BRAND_PROFILE, id: 'default', companyId, createdAt: new Date(), updatedAt: new Date() };

  // 4. Run pre-export checks unless skipChecks is set
  if (!options?.skipChecks) {
    const checks = await runPreExportChecks(documentId, companyId, document.reportingFramework);
    const failedBlockers = checks.filter((c) => c.severity === 'blocker' && !c.passed);

    if (failedBlockers.length > 0) {
      const labels = failedBlockers.map((c) => c.label).join(', ');
      log.warn('pdfExportService: export blocked by failing checks', { failedBlockers });
      throw new Error(`Export blocked: ${labels}`);
    }

    const warnings = checks.filter((c) => c.severity === 'warning' && !c.passed);
    if (warnings.length > 0) {
      log.warn('pdfExportService: export has warnings', { warnings });
    }
  }

  // 5. Load company info — unless the caller supplies the values it fingerprinted
  let companyName: string;
  let registrationNumber: string;
  if (options?.inputs) {
    companyName        = options.inputs.companyName;
    registrationNumber = options.inputs.registrationNumber ?? '';
  } else {
    const companyRows = (await sql`
      SELECT name, registration_number
      FROM   companies
      WHERE  id = ${companyId}::UUID
    `) as Record<string, unknown>[];
    const companyRow = companyRows[0];
    if (companyRow === undefined) {
      throw new Error(`Company not found: ${companyId}`);
    }
    companyName        = companyRow.name as string;
    registrationNumber = (companyRow.registration_number as string | null) ?? '';
  }

  // 6. Render HTML. Defence-in-depth: WeasyPrint fetches the logo URL server-side, so
  // re-validate it here (covers rows stored before the save-time guard) and drop it if it
  // now resolves to a private/reserved address rather than letting WeasyPrint reach it (H2).
  let safeBrandProfile = brandProfile;
  if (brandProfile.logoUrl) {
    const reason = await checkPublicUrl(brandProfile.logoUrl);
    if (reason) {
      log.warn('pdfExportService: dropping non-public logoUrl from render', { companyId, reason });
      safeBrandProfile = { ...brandProfile, logoUrl: null };
    }
  }

  // Charts for the statement pages. Additive: a section with no builder
  // registered renders exactly as it does today.
  const charts = buildAfsCharts(sections);

  return renderAfsToHtml(
    { document, sections, brandProfile: safeBrandProfile, companyName, registrationNumber, charts },
    { watermark: options?.watermark },
  );
}

// ── Main export function ──────────────────────────────────────────────────────

export async function exportToPdf(
  documentId: string,
  companyId: string,
  options?: PdfExportOptions,
): Promise<Buffer> {
  log.info('pdfExportService.exportToPdf', { documentId, companyId, options });

  const html = await renderDocumentHtml(documentId, companyId, options);
  const buffer = await htmlToPdf(html);

  log.info('pdfExportService.exportToPdf complete', { documentId, bytes: buffer.length });
  return buffer;
}
