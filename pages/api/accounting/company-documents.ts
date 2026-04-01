/**
 * Company Documents API
 * GET  ?companyId=      — list active documents (without file_data)
 * GET  ?id=&download=1  — single doc with file_data for download
 * POST                  — create a new document
 * DELETE ?id=           — soft-delete a document
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { isVlmAvailable } from '@/modules/accounting/services/vlmService';
import { extractStatutoryDocWithVlm } from '@/modules/accounting/services/vlmService';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  // ── Helper: validate company membership ──
  async function validateMembership(companyId: string): Promise<boolean> {
    const rows = (await sql`
      SELECT role FROM company_users
      WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
    `) as Row[];
    return rows.length > 0;
  }

  // ── GET ──
  if (req.method === 'GET') {
    // Download single doc
    if (req.query.id && req.query.download === '1') {
      const rows = (await sql`
        SELECT id, company_id, document_type, document_name, file_data,
               mime_type, file_size, uploaded_at, notes
        FROM company_documents
        WHERE id = ${req.query.id as string}::UUID AND is_active = true
      `) as Row[];
      if (rows.length === 0) return apiResponse.notFound(res, 'Document');
      const doc = rows[0];
      if (!(await validateMembership(doc.company_id))) {
        return apiResponse.forbidden(res, 'You do not have access to this company');
      }
      return apiResponse.success(res, {
        id: doc.id,
        documentType: doc.document_type,
        documentName: doc.document_name,
        fileData: doc.file_data,
        mimeType: doc.mime_type,
        fileSize: doc.file_size,
        uploadedAt: doc.uploaded_at,
        notes: doc.notes,
      });
    }

    // List docs for a company
    const companyId = req.query.companyId as string;
    if (!companyId) return apiResponse.badRequest(res, 'companyId is required');
    if (!(await validateMembership(companyId))) {
      return apiResponse.forbidden(res, 'You do not have access to this company');
    }

    const rows = (await sql`
      SELECT id, document_type, document_name, mime_type,
             file_size, uploaded_at, notes
      FROM company_documents
      WHERE company_id = ${companyId}::UUID AND is_active = true
      ORDER BY uploaded_at DESC
    `) as Row[];

    return apiResponse.success(res, {
      items: rows.map((r: Row) => ({
        id: r.id,
        documentType: r.document_type,
        documentName: r.document_name,
        mimeType: r.mime_type,
        fileSize: r.file_size,
        uploadedAt: r.uploaded_at,
        notes: r.notes,
      })),
    });
  }

  // ── POST ──
  if (req.method === 'POST') {
    const { companyId, documentType, documentName, fileData, mimeType, fileSize, notes } = req.body;
    if (!companyId || !documentType || !documentName || !fileData) {
      return apiResponse.badRequest(res, 'companyId, documentType, documentName, and fileData are required');
    }
    if (!(await validateMembership(companyId))) {
      return apiResponse.forbidden(res, 'You do not have access to this company');
    }

    const rows = (await sql`
      INSERT INTO company_documents (
        company_id, document_type, document_name,
        file_data, mime_type, file_size, uploaded_by, notes
      ) VALUES (
        ${companyId}::UUID, ${documentType}, ${documentName},
        ${fileData}, ${mimeType || 'application/octet-stream'},
        ${fileSize || 0}, ${userId}, ${notes || null}
      )
      RETURNING id
    `) as Row[];

    const docId = rows[0].id as string;

    // Fire-and-forget VLM extraction for statutory documents
    if (isVlmAvailable() && fileData) {
      extractStatutoryDocData(fileData, documentType, docId).catch(err =>
        log.warn('Statutory doc extraction failed', { error: err instanceof Error ? err.message : String(err) }, 'company-docs')
      );
    }

    return apiResponse.created(res, { id: docId });
  }

  // ── DELETE (soft) ──
  if (req.method === 'DELETE') {
    const docId = req.query.id as string;
    if (!docId) return apiResponse.badRequest(res, 'id is required');

    const rows = (await sql`
      SELECT company_id FROM company_documents
      WHERE id = ${docId}::UUID AND is_active = true
    `) as Row[];
    if (rows.length === 0) return apiResponse.notFound(res, 'Document');
    if (!(await validateMembership(rows[0].company_id))) {
      return apiResponse.forbidden(res, 'You do not have access to this company');
    }

    await sql`
      UPDATE company_documents SET is_active = false WHERE id = ${docId}::UUID
    `;
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'DELETE']);
}

/** Background statutory document VLM extraction */
async function extractStatutoryDocData(fileData: string, docType: string, docId: string) {
  // fileData is a base64 data URL
  const match = fileData.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return;
  const mimeType = match[1]!;
  const base64 = match[2]!;

  const docTypeMap: Record<string, string> = {
    cipc_certificate: 'cipc',
    tax_clearance: 'tax_clearance',
    bbbee_certificate: 'bbee',
    vat_registration: 'vat_registration',
  };

  const result = await extractStatutoryDocWithVlm(base64, mimeType, docTypeMap[docType] || undefined);
  if (result) {
    await sql`
      UPDATE company_documents
      SET extracted_data = ${JSON.stringify(result)}::jsonb
      WHERE id = ${docId}::uuid
    `;
    log.info('Statutory doc extraction stored', { docId, docType: result.documentType }, 'company-docs');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};
