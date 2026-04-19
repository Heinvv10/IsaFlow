/**
 * Practice Client Contact by ID API
 * DELETE /api/accounting/practice/client-contacts/[id] - Delete a contact
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { deleteClientContact } from '@/modules/accounting/services/practice/practiceClientService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (req.method === 'DELETE') {
    await deleteClientContact(companyId, id);
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
