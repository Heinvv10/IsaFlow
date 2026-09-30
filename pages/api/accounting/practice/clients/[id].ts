/**
 * Practice Client by ID API
 * GET    /api/accounting/practice/clients/[id] - Get a single practice client
 * PUT    /api/accounting/practice/clients/[id] - Update a practice client
 * DELETE /api/accounting/practice/clients/[id] - Delete a practice client
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { ClientGroupNotInCompanyError } from '@/modules/accounting/services/practice/practiceClientFence';
import { isUuidParam } from '@/lib/validation';
import {
  getPracticeClient,
  updatePracticeClient,
  deletePracticeClient,
} from '@/modules/accounting/services/practice/practiceClientService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;
  // R-170: an unguarded id reached the ::UUID cast in the first read on every
  // method here, none of it savepointed — a malformed id 500'd instead of 400.
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'Invalid client ID');

  if (req.method === 'GET') {
    const client = await getPracticeClient(companyId, id);
    if (!client) return apiResponse.notFound(res, 'Client not found');
    return apiResponse.success(res, client);
  }

  if (req.method === 'PUT') {
    try {
      const client = await updatePracticeClient(companyId, id, req.body);
      return apiResponse.success(res, client);
    } catch (err) {
      if (err instanceof CustomerNotInCompanyError || err instanceof ClientGroupNotInCompanyError) {
        return apiResponse.badRequest(res, err.message);
      }
      throw err;
    }
  }

  if (req.method === 'DELETE') {
    await deletePracticeClient(companyId, id);
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
