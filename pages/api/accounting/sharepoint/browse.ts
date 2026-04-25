/**
 * GET /api/accounting/sharepoint/browse
 *
 * Query params:
 *   path — server-relative folder path (e.g. "Shared Documents/Invoices")
 *
 * Returns: { files: SpFile[], folders: SpFolder[] }
 *
 * Returns 400 if SharePoint env vars are not configured.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listFolder } from '@/lib/sharepointClient';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  if (!process.env.AZURE_CLIENT_ID) {
    return apiResponse.badRequest(res, 'SharePoint not configured');
  }

  const { path } = req.query;
  const folderPath = typeof path === 'string' && path.trim()
    ? path.trim()
    : 'Shared Documents';

  log.info('SharePoint browse', { path: folderPath, companyId: req.companyId }, 'sharepoint-browse');

  const contents = await listFolder(folderPath);
  return apiResponse.success(res, contents);
}

export default withAuth(withErrorHandler(handler));
