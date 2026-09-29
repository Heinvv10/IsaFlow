/**
 * Practice Client Contacts API
 * GET  /api/accounting/practice/client-contacts?clientId=  - List contacts for a client
 * POST /api/accounting/practice/client-contacts             - Create a contact
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listClientContacts,
  createClientContact,
} from '@/modules/accounting/services/practice/practiceClientService';
import { PracticeClientNotInCompanyError } from '@/modules/accounting/services/practice/practiceClientFence';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const clientId = req.query.clientId as string;
    if (!clientId) return apiResponse.badRequest(res, 'clientId query param required');
    return apiResponse.success(res, await listClientContacts(companyId, clientId));
  }

  if (req.method === 'POST') {
    const { clientId, name, email, phone, role, isPrimary } = req.body;
    if (!clientId) return apiResponse.badRequest(res, 'clientId is required');
    if (!name) return apiResponse.badRequest(res, 'name is required');
    try {
      return apiResponse.created(
        res,
        await createClientContact(companyId, clientId, { name, email, phone, role, isPrimary }),
      );
    } catch (err) {
      if (err instanceof PracticeClientNotInCompanyError) return apiResponse.badRequest(res, err.message);
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
