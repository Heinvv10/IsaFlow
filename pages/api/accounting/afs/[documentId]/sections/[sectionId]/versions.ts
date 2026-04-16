// pages/api/accounting/afs/[documentId]/sections/[sectionId]/versions.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  assertDocumentEditable,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';
import {
  listVersions,
  restoreVersion,
  VersionHistoryError,
} from '@/modules/accounting/services/afs/afsVersionHistoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;

  if (req.method === 'GET') {
    try {
      const items = await listVersions(companyId, sectionId);
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
    const { version } = req.body ?? {};

    if (typeof version !== 'number' || version < 1) {
      return apiResponse.badRequest(res, '"version" must be a positive integer');
    }

    log.info('Version restore requested', { companyId, documentId, sectionId, version, userId }, 'afs-versions-api');

    try {
      await assertDocumentEditable(companyId, documentId);
    } catch (err) {
      if (err instanceof ReviewError) {
        if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
        return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
      }
      throw err;
    }

    try {
      const newVersionEntry = await restoreVersion(companyId, sectionId, version, userId);
      return apiResponse.success(res, {
        sectionId,
        restoredVersion: version,
        newVersionEntry,
      }, 'Version restored');
    } catch (err) {
      if (err instanceof VersionHistoryError) {
        if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'Section', sectionId);
        if (err.code === 'VERSION_NOT_FOUND') return apiResponse.notFound(res, 'Version', String(version));
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as never));
