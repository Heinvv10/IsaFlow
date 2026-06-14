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
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkRateLimit } from '@/lib/rateLimit';
import { magicBytesMatchMime, decodeUploadPayload } from '@/lib/fileMagic';
import { sql } from '@/lib/neon';
import { isVlmAvailable } from '@/modules/accounting/services/bank/vlmService';
import { extractStatutoryDocWithVlm } from '@/modules/accounting/services/bank/vlmService';
import { log } from '@/lib/logger';
type Row = Record<string, unknown>;


// Uses withAuth (not withAuth) because documents can be uploaded for any company
// the user belongs to. Security is provided by validateMembership() before every
// read/write — companyId from the request is always validated against company_users.
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
      const docDownloadId = typeof req.query.id === 'string' ? req.query.id : undefined;
      if (!docDownloadId) return apiResponse.badRequest(res, 'id must be a single value');
      const rows = (await sql`
        SELECT id, company_id, document_type, document_name, file_data,
               mime_type, file_size, uploaded_at, notes
        FROM company_documents
        WHERE id = ${docDownloadId}::UUID AND is_active = true
      `) as Row[];
      if (rows.length === 0) return apiResponse.notFound(res, 'Document');
      const doc = rows[0]!;
      if (!(await validateMembership(String(doc.company_id)))) {
        return apiResponse.forbidden(res, 'You do not have access to this company');
      }
      return apiResponse.success(res, {
        id: String(doc.id),
        documentType: String(doc.document_type),
        documentName: String(doc.document_name),
        fileData: doc.file_data,
        mimeType: String(doc.mime_type),
        fileSize: doc.file_size,
        uploadedAt: doc.uploaded_at,
        notes: doc.notes ?? null,
      });
    }

    // List docs for a company
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
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
        id: String(r.id),
        documentType: String(r.document_type),
        documentName: String(r.document_name),
        mimeType: String(r.mime_type),
        fileSize: r.file_size,
        uploadedAt: r.uploaded_at,
        notes: r.notes ?? null,
      })),
    });
  }

  // ── POST ──
  if (req.method === 'POST') {
    const { companyId, documentType, documentName, fileData, mimeType, fileSize, notes } = req.body;
    if (!companyId || !documentType || !documentName || !fileData) {
      return apiResponse.badRequest(res, 'companyId, documentType, documentName, and fileData are required');
    }
    const ALLOWED_DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
    // M15: MIME mandatory + allowlisted (the old `if (mimeType && ...)` skipped the
    // check when omitted), and the decoded bytes must match the claimed type.
    if (!mimeType || !ALLOWED_DOC_MIMES.includes(mimeType as string)) {
      return apiResponse.badRequest(res, `File type ${mimeType || '(missing)'} not allowed`);
    }
    const docBuf = decodeUploadPayload(String(fileData));
    if (!docBuf || !magicBytesMatchMime(docBuf, mimeType as string)) {
      return apiResponse.badRequest(res, 'File contents do not match the declared type');
    }
    if (!(await validateMembership(companyId))) {
      return apiResponse.forbidden(res, 'You do not have access to this company');
    }
    // Pentest M22: 50 MB bodyParser + no rate limit was a bandwidth/memory
    // DoS vector. 30 uploads/hr per tenant is plenty for document ingest.
    if (!(await checkRateLimit(`company-docs:${companyId}`, { max: 30, windowSecs: 3600 }))) {
      return apiResponse.tooManyRequests(res);
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

    const docId = String(rows[0]!.id);

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
    const docId = typeof req.query.id === 'string' ? req.query.id : undefined;
    if (!docId) return apiResponse.badRequest(res, 'id is required');

    const rows = (await sql`
      SELECT company_id FROM company_documents
      WHERE id = ${docId}::UUID AND is_active = true
    `) as Row[];
    if (rows.length === 0) return apiResponse.notFound(res, 'Document');
    if (!(await validateMembership(String(rows[0]!.company_id)))) {
      return apiResponse.forbidden(res, 'You do not have access to this company');
    }

    await sql`
      UPDATE company_documents SET is_active = false WHERE id = ${docId}::UUID AND company_id = ${String(rows[0]!.company_id)}::UUID
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

 
export default withAuth(withErrorHandler(withCsrf(handler)));

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};
