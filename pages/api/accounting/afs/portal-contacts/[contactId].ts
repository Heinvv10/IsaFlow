// pages/api/accounting/afs/portal-contacts/[contactId].ts — PUT / DELETE
// Auth: withAuth (staff-only)

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  updatePortalContact,
  deletePortalContact,
} from '@/modules/accounting/services/afs/portalContactsService';
import type { PortalRole } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const contactId = req.query.contactId as string;
  if (!contactId) return apiResponse.badRequest(res, 'contactId is required');

  if (req.method === 'PUT') {
    const { name, role, active } = req.body as {
      name?: string;
      role?: PortalRole;
      active?: boolean;
    };
    try {
      const contact = await updatePortalContact(companyId, contactId, {
        name,
        role,
        active,
      });
      return apiResponse.success(res, { contact });
    } catch (err) {
      if (err instanceof Error && err.message === 'CONTACT_NOT_FOUND') {
        return apiResponse.notFound(res, 'Portal contact', contactId);
      }
      throw err;
    }
  }

  if (req.method === 'DELETE') {
    log.info('Soft-deleting portal contact', { companyId, contactId }, 'portal-contacts-api');
    await deletePortalContact(companyId, contactId);
    return apiResponse.noContent(res);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(handler as never));
