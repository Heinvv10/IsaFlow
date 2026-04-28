// pages/api/accounting/afs/portal-contacts/[contactId].ts — PUT / DELETE
// Auth: withAuth (staff-only)

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import {
  updatePortalContact,
  deletePortalContact,
} from '@/modules/accounting/services/afs/portalContactsService';

const UpdateContactSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: z.enum(['director', 'cfo', 'shareholder_readonly', 'external_auditor']).optional(),
  active: z.boolean().optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const idParse = UUID.safeParse(req.query.contactId);
  if (!idParse.success) return apiResponse.badRequest(res, 'contactId must be a valid UUID');
  const contactId = idParse.data;

  if (req.method === 'PUT') {
    const parsed = UpdateContactSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    try {
      const contact = await updatePortalContact(companyId, contactId, parsed.data);
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

export default withAuth(withErrorHandler(withCsrf(handler as never)));
