/**
 * POST /api/onboarding/documents
 * Upload statutory documents during onboarding.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkRateLimit } from '@/lib/rateLimit';
import { magicBytesMatchMime, decodeUploadPayload } from '@/lib/fileMagic';
import { sql, transaction } from '@/lib/neon';

interface DocumentPayload {
  type: string;
  name: string;
  data: string;
  mimeType: string;
  size: number;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { companyId, documents } = req.body as {
    companyId?: string;
    documents?: DocumentPayload[];
  };

  if (!companyId) return apiResponse.badRequest(res, 'companyId is required');
  if (!documents || !Array.isArray(documents) || documents.length === 0) {
    return apiResponse.badRequest(res, 'documents array is required');
  }
  // Pentest H15/M22: cap array length + rate-limit the 50MB bodyParser.
  if (documents.length > 20) {
    return apiResponse.badRequest(res, 'Maximum 20 documents per request');
  }
  if (!(await checkRateLimit(`onboarding-docs:${companyId}`, { max: 15, windowSecs: 3600 }))) {
    return apiResponse.tooManyRequests(res);
  }

  const ALLOWED_DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
  const MAX_DOC_BYTES = 20 * 1024 * 1024;
  for (const doc of documents) {
    // H5: MIME is mandatory + allowlisted — the old `if (doc.mimeType && ...)` skipped
    // the check entirely when the client omitted mimeType.
    if (!doc.mimeType || !ALLOWED_DOC_MIMES.includes(doc.mimeType)) {
      return apiResponse.badRequest(res, `File type ${doc.mimeType || '(missing)'} not allowed`);
    }
    // H5: validate the real decoded bytes match the claimed type (defeats spoofed/polyglot uploads).
    const buf = decodeUploadPayload(doc.data);
    if (!buf) return apiResponse.badRequest(res, `Document "${doc.name}": invalid or empty file data`);
    if (buf.length > MAX_DOC_BYTES) {
      return apiResponse.badRequest(res, `Document "${doc.name}" exceeds the 20 MB limit`);
    }
    if (!magicBytesMatchMime(buf, doc.mimeType)) {
      return apiResponse.badRequest(res, `Document "${doc.name}": contents do not match ${doc.mimeType}`);
    }
  }

  // Validate company membership
  const membership = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
  `) as { role: string }[];

  if (membership.length === 0) {
    return apiResponse.forbidden(res, 'You do not have access to this company');
  }

  // Insert all documents in a single transaction
  await transaction((txSql) =>
    documents.map((doc) =>
      txSql`
        INSERT INTO company_documents (
          company_id, document_type, document_name,
          file_data, mime_type, file_size, uploaded_by
        ) VALUES (
          ${companyId}::UUID, ${doc.type}, ${doc.name},
          ${doc.data}, ${doc.mimeType}, ${doc.size}, ${userId}
        )
      `
    )
  );

  return apiResponse.created(res, { count: documents.length });
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};
