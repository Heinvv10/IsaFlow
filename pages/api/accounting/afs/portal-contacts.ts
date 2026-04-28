// pages/api/accounting/afs/portal-contacts.ts — GET / POST
// Auth: withAuth (staff-only)

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listPortalContacts,
  createPortalContact,
} from '@/modules/accounting/services/afs/portalContactsService';

const CreateContactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(254),
  role: z.enum(['director', 'cfo', 'shareholder_readonly', 'external_auditor']),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    log.info('Listing portal contacts', { companyId }, 'portal-contacts-api');
    const contacts = await listPortalContacts(companyId);
    return apiResponse.success(res, { contacts });
  }

  if (req.method === 'POST') {
    const parsed = CreateContactSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const { name, email, role } = parsed.data;

    try {
      const contact = await createPortalContact(companyId, {
        name,
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

export default withAuth(withErrorHandler(withCsrf(handler as never)));
