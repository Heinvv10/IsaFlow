// pages/api/accounting/afs/[documentId]/sections/[sectionId]/versions.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { requireUuidParam } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { ReviewError } from '@/modules/accounting/services/afs/afsReviewService';
import {
  listVersions,
  restoreVersion,
  VersionHistoryError,
} from '@/modules/accounting/services/afs/afsVersionHistoryService';

const RestoreSchema = z.object({
  version: z.number().int().min(1),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;
  const sectionId = requireUuidParam(req, res, 'sectionId');
  if (!sectionId) return;

  if (req.method === 'GET') {
    try {
      const items = await listVersions(companyId, documentId, sectionId);
      return apiResponse.success(res, { items });
    } catch (err) {
      if (err instanceof VersionHistoryError && err.code === 'NOT_FOUND') {
        return apiResponse.notFound(res, 'Section', sectionId);
      }
      throw err;
    }
  }

  if (req.method === 'POST') {
    const userId = companyReq.user.id;
    const parsed = RestoreSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const { version } = parsed.data;

    log.info('Version restore requested', { companyId, documentId, sectionId, version, userId }, 'afs-versions-api');

    try {
      const newVersionEntry = await restoreVersion(companyId, documentId, sectionId, version, userId);
      return apiResponse.success(res, {
        sectionId,
        restoredVersion: version,
        newVersionEntry,
      }, 'Version restored');
    } catch (err) {
      // restoreVersion binds the section to this document and refuses a locked one.
      if (err instanceof ReviewError) {
        if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'Section', sectionId);
        return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
      }
      if (err instanceof VersionHistoryError) {
        if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'Section', sectionId);
        if (err.code === 'VERSION_NOT_FOUND') return apiResponse.notFound(res, 'Version', String(version));
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
