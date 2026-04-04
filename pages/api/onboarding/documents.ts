/**
 * POST /api/onboarding/documents
 * Upload statutory documents during onboarding.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
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

  const ALLOWED_DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
  for (const doc of documents) {
    if (doc.mimeType && !ALLOWED_DOC_MIMES.includes(doc.mimeType)) {
      return apiResponse.badRequest(res, `File type ${doc.mimeType} not allowed`);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};
