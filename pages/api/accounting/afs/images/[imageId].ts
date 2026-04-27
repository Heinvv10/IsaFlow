// pages/api/accounting/afs/images/[imageId].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { deleteImage } from '@/modules/accounting/services/afs/imageLibraryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['DELETE']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const imageId = req.query.imageId as string;

  log.info('Deleting AFS image', { companyId, imageId }, 'afs-images-api');

  try {
    await deleteImage(companyId, imageId);
    return res.status(204).end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Image not found') {
      return apiResponse.notFound(res, 'Image', imageId);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
