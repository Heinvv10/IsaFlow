/**
 * /api/accounting/ar/sent-mirror/connections
 *   GET  — list sent-mirror connections for the current company
 *   POST — create an IMAP-password connection (Gmail/M365 via /oauth later)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import {
  listSentConnectionSummaries,
  createSentImapConnection,
} from '@/modules/accounting/services/ar/sentMirrorAdmin';

interface CreateImapBody {
  displayName?: string;
  accountEmail?: string;
  imapHost?: string;
  imapPort?: number;
  imapUseTls?: boolean;
  imapUsername?: string;
  imapPassword?: string;
  sentFolder?: string;
  scanIntervalMinutes?: number;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const items = await listSentConnectionSummaries(companyId);
    return apiResponse.success(res, { items, total: items.length });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as CreateImapBody;
    if (!body.displayName || !body.accountEmail || !body.imapHost || !body.imapPort
        || !body.imapUsername || !body.imapPassword) {
      return apiResponse.badRequest(
        res,
        'displayName, accountEmail, imapHost, imapPort, imapUsername, imapPassword are required',
      );
    }

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

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
