// pages/api/accounting/afs/[documentId]/export.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { exportToPdf } from '@/modules/accounting/services/afs/pdfExportService';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import { buildFullCasewarePackage } from '@/modules/accounting/services/afs/casewareExportExtService';
import type { AfsDocument, AfsSection, SectionType, SectionStatus, DocumentType, DocumentStatus, ReportingFramework, NoteContent, AfsSectionVersionEntry } from '@/modules/accounting/services/afs/afsTypes';

const ALLOWED_FORMATS = ['pdf', 'docx', 'caseware'] as const;
type ExportFormat = typeof ALLOWED_FORMATS[number];

function mapDocumentRow(row: Record<string, unknown>): AfsDocument {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    fiscalYear: (row.fiscal_year as number | null) ?? null,
    period: (row.period as string | null) ?? null,
    documentType: row.document_type as DocumentType,
    reportingFramework: row.reporting_framework as ReportingFramework,
    status: row.status as DocumentStatus,
    lockedAt: (row.locked_at as Date | null) ?? null,
    lockedBy: (row.locked_by as string | null) ?? null,
    version: row.version as number,
    pisScore: (row.pis_score as number | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapSectionRow(row: Record<string, unknown>): AfsSection {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    companyId: row.company_id as string,
    sectionType: row.section_type as SectionType,
    sortOrder: row.sort_order as number,
    status: row.status as SectionStatus,
    dataSnapshot: (row.data_snapshot as Record<string, unknown> | null) ?? null,
    content: (row.content as NoteContent | null) ?? null,
    overrides: (row.overrides as Partial<NoteContent> | null) ?? null,
    aiNarrative: (row.ai_narrative as string | null) ?? null,
    aiNarrativeAccepted: (row.ai_narrative_accepted as boolean) ?? false,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    reviewedAt: (row.reviewed_at as Date | null) ?? null,
    signedOffBy: (row.signed_off_by as string | null) ?? null,
    signedOffAt: (row.signed_off_at as Date | null) ?? null,
    versionHistory: (row.version_history as AfsSectionVersionEntry[]) ?? [],
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const documentId = req.query.documentId as string;
  const format = req.query.format as string | undefined;

  if (!format || !(ALLOWED_FORMATS as readonly string[]).includes(format)) {
    return apiResponse.badRequest(res, 'format must be pdf, docx, or caseware');
  }

  const exportFormat = format as ExportFormat;

  log.info('AFS export requested', { companyId, documentId, format: exportFormat }, 'afs-export-api');

  try {
    if (exportFormat === 'pdf') {
      const buffer = await exportToPdf(documentId, companyId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="afs-${documentId}.pdf"`);
      return res.status(200).send(buffer);
    }

    if (exportFormat === 'docx') {
      const docRows = (await sql`
        SELECT * FROM afs_documents
        WHERE id = ${documentId}::UUID
          AND company_id = ${companyId}::UUID
      `) as Record<string, unknown>[];

      if (docRows.length === 0 || docRows[0] === undefined) {
        return apiResponse.notFound(res, 'Document', documentId);
      }

      const sectionRows = (await sql`
        SELECT * FROM afs_sections
        WHERE document_id = ${documentId}::UUID
          AND company_id = ${companyId}::UUID
        ORDER BY sort_order ASC
      `) as Record<string, unknown>[];

      const companyRows = (await sql`
        SELECT name FROM companies WHERE id = ${companyId}::UUID
      `) as Record<string, unknown>[];

      const document = mapDocumentRow(docRows[0]);
      const sections = sectionRows.map(mapSectionRow);
      const companyName = (companyRows[0]?.name as string | undefined) ?? '';

      const buffer = await renderToDocx(document, sections, companyName);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="afs-${documentId}.docx"`);
      return res.status(200).send(buffer);
    }

    // caseware
    const pkg = await buildFullCasewarePackage(documentId, companyId);
    return apiResponse.success(res, pkg.files.map(f => ({
      name: f.name,
      mimeType: f.mimeType,
      size: f.content.length,
    })));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Export blocked')) {
      return apiResponse.badRequest(res, message);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
