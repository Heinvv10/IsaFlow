// pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  assertDocumentEditable,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';
import {
  saveVersion,
  VersionHistoryError,
} from '@/modules/accounting/services/afs/afsVersionHistoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;
  const { overrides } = req.body ?? {};

  if (!overrides || typeof overrides !== 'object') {
    return apiResponse.badRequest(res, 'Request body must include an "overrides" object');
  }

  log.info('Section overrides update', { companyId, documentId, sectionId, userId }, 'afs-overrides-api');

  try {
    await assertDocumentEditable(companyId, documentId);
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }

  // Save version snapshot BEFORE applying overrides
  let versionEntry;
  try {
    versionEntry = await saveVersion(companyId, sectionId, userId);
  } catch (err) {
    if (err instanceof VersionHistoryError && err.code === 'NOT_FOUND') {
      return apiResponse.notFound(res, 'Section', sectionId);
    }
    throw err;
  }

  // Apply new overrides
  await sql`
    UPDATE afs_sections
    SET overrides = ${JSON.stringify(overrides)}::jsonb,
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  return apiResponse.success(res, { sectionId, version: versionEntry }, 'Overrides applied');
}

export default withCompany(withErrorHandler(handler as never));
