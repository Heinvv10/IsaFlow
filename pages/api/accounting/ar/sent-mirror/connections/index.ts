/**
 * /api/accounting/ar/sent-mirror/connections
 *   GET  — list sent-mirror connections for the current company
 *   POST — create an IMAP-password connection (Gmail/M365 via /oauth later)
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listSentConnectionSummaries,
  createSentImapConnection,
} from '@/modules/accounting/services/ar/sentMirrorAdmin';

const CreateImapSchema = z.object({
  displayName: z.string().min(1).max(200),
  accountEmail: z.string().email().max(254),
  imapHost: z.string().min(1).max(253),
  imapPort: z.number().int().min(1).max(65535),
  imapUseTls: z.boolean().optional(),
  imapUsername: z.string().min(1).max(254),
  imapPassword: z.string().min(1).max(500),
  sentFolder: z.string().max(200).optional(),
  scanIntervalMinutes: z.number().int().min(1).max(1440).optional(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const items = await listSentConnectionSummaries(companyId);
    return apiResponse.success(res, { items, total: items.length });
  }

  if (req.method === 'POST') {
    const parsed = CreateImapSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const body = parsed.data;
    const created = await createSentImapConnection({
      companyId,
      createdBy: req.user?.id ?? null,
      displayName: body.displayName,
      accountEmail: body.accountEmail,
      imapHost: body.imapHost,
      imapPort: body.imapPort,
      imapUseTls: body.imapUseTls,
      imapUsername: body.imapUsername,
      imapPassword: body.imapPassword,
      sentFolder: body.sentFolder,
      scanIntervalMinutes: body.scanIntervalMinutes,
    });

    return apiResponse.created(res, { connection: created });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
