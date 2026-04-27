import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  AfsDocument,
  CreateAfsDocumentInput,
  DocumentType,
  DocumentStatus,
  ReportingFramework,
} from './afsTypes';

function rowToAfsDocument(row: Record<string, unknown>): AfsDocument {
  return {
    id:                 row.id as string,
    companyId:          row.company_id as string,
    fiscalYear:         row.fiscal_year != null ? Number(row.fiscal_year) : null,
    period:             (row.period as string | null) ?? null,
    documentType:       row.document_type as DocumentType,
    reportingFramework: row.reporting_framework as ReportingFramework,
    status:             row.status as DocumentStatus,
    lockedAt:           row.locked_at instanceof Date ? row.locked_at
                          : row.locked_at != null ? new Date(row.locked_at as string) : null,
    lockedBy:           (row.locked_by as string | null) ?? null,
    version:            Number(row.version),
    pisScore:           row.pis_score != null ? Number(row.pis_score) : null,
    createdAt:          row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
    updatedAt:          row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string),
  };
}

export class AfsDocumentDuplicateError extends Error {
  readonly existing: { fiscalYear: number | null; period: string | null; documentType: DocumentType };
  constructor(existing: { fiscalYear: number | null; period: string | null; documentType: DocumentType }) {
    super(
      existing.documentType === 'afs'
        ? `An AFS document for fiscal year ${existing.fiscalYear} already exists.`
        : `A management pack for ${existing.period} already exists.`
    );
    this.name = 'AfsDocumentDuplicateError';
    this.existing = existing;
  }
}

export async function createAfsDocument(input: CreateAfsDocumentInput): Promise<AfsDocument> {
  log.info('Creating AFS document', { companyId: input.companyId, documentType: input.documentType }, 'afsDocumentService');

  try {
    const rows = await sql`
      INSERT INTO afs_documents (
        company_id, fiscal_year, period, document_type, reporting_framework
      ) VALUES (
        ${input.companyId}::UUID,
        ${input.fiscalYear ?? null},
        ${input.period ?? null},
        ${input.documentType},
        ${input.reportingFramework}
      )
      RETURNING *
    `;

    if (rows.length === 0) {
      throw new Error('Failed to create AFS document');
    }

    return rowToAfsDocument(rows[0] as Record<string, unknown>);
  } catch (err) {
    // Postgres unique violation: 23505. Translate to a friendly domain error
    // so the route handler can return a 409 with a clear message instead of 500.
    if (err instanceof Error && /unique|duplicate key/i.test(err.message)) {
      throw new AfsDocumentDuplicateError({
        fiscalYear: input.fiscalYear ?? null,
        period: input.period ?? null,
        documentType: input.documentType,
      });
    }
    throw err;
  }
}

export async function getAfsDocument(
  documentId: string,
  companyId: string
): Promise<AfsDocument | null> {
  const rows = await sql`
    SELECT * FROM afs_documents
    WHERE id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  return rowToAfsDocument(rows[0] as Record<string, unknown>);
}

export async function listAfsDocuments(companyId: string): Promise<AfsDocument[]> {
  const rows = await sql`
    SELECT * FROM afs_documents
    WHERE company_id = ${companyId}::UUID
    ORDER BY created_at DESC
  `;

  return rows.map(r => rowToAfsDocument(r as Record<string, unknown>));
}

export async function lockAfsDocument(
  documentId: string,
  companyId: string,
  lockedBy: string
): Promise<AfsDocument> {
  log.info('Locking AFS document', { documentId, companyId, lockedBy }, 'afsDocumentService');

  const rows = await sql`
    UPDATE afs_documents
    SET
      status     = 'signed_off',
      locked_at  = now(),
      locked_by  = ${lockedBy},
      updated_at = now()
    WHERE id         = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
      AND status NOT IN ('signed_off', 'filed')
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new Error('Document not found or already locked');
  }

  return rowToAfsDocument(rows[0] as Record<string, unknown>);
}
