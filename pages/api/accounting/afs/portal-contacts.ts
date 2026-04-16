// pages/api/accounting/afs/portal-contacts.ts — GET / POST
// Auth: withCompany (staff-only)

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  listPortalContacts,
  createPortalContact,
} from '@/modules/accounting/services/afs/portalContactsService';
import type { PortalRole } from '@/modules/accounting/services/afs/afsTypes';

const VALID_ROLES: PortalRole[] = ['director', 'cfo', 'shareholder_readonly', 'external_auditor'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    log.info('Listing portal contacts', { companyId }, 'portal-contacts-api');
    const contacts = await listPortalContacts(companyId);
    return apiResponse.success(res, { contacts });
  }

  if (req.method === 'POST') {
    const { name, email, role } = req.body as { name?: string; email?: string; role?: PortalRole };

    if (!name || typeof name !== 'string' || !name.trim()) {
      return apiResponse.badRequest(res, 'name is required');
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return apiResponse.badRequest(res, 'A valid email is required');
    }
    if (!role || !VALID_ROLES.includes(role)) {
      return apiResponse.badRequest(res, `role must be one of: ${VALID_ROLES.join(', ')}`);
    }

    try {
      const contact = await createPortalContact(companyId, {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        role,
      });
      return apiResponse.created(res, { contact }, 'Portal contact created');
    } catch (err) {
      if (err instanceof Error && err.message === 'DUPLICATE_EMAIL') {
        return apiResponse.badRequest(res, 'A contact with this email already exists');
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as never));
