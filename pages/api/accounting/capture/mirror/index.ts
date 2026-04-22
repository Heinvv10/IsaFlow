/**
 * /api/accounting/capture/mirror
 *   GET  — list mirror connections for the current company
 *   POST — create an IMAP-password connection (Gmail/M365 use /oauth/start)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import {
  listMirrorConnections,
  createImapConnection,
} from '@/modules/accounting/services/capture/mirrorConnectionService';

interface CreateImapBody {
  displayName?: string;
  accountEmail?: string;
  imapHost?: string;
  imapPort?: number;
  imapUseTls?: boolean;
  imapUsername?: string;
  imapPassword?: string;
  folder?: string;
  scanIntervalMinutes?: number;
  allowedSenders?: string[];
  deniedSenders?: string[];
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const items = await listMirrorConnections(companyId);
    return apiResponse.success(res, { items, total: items.length });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as CreateImapBody;
    if (!body.displayName || !body.accountEmail || !body.imapHost || !body.imapPort
        || !body.imapUsername || !body.imapPassword) {
      return apiResponse.badRequest(res, 'displayName, accountEmail, imapHost, imapPort, imapUsername, imapPassword are required');
    }

    const created = await createImapConnection({
      companyId,
      createdBy: req.user?.id ?? null,
      displayName: body.displayName,
      accountEmail: body.accountEmail,
      imapHost: body.imapHost,
      imapPort: body.imapPort,
      imapUseTls: body.imapUseTls,
      imapUsername: body.imapUsername,
      imapPassword: body.imapPassword,
      folder: body.folder,
      scanIntervalMinutes: body.scanIntervalMinutes,
      allowedSenders: body.allowedSenders,
      deniedSenders: body.deniedSenders,
    });

    return apiResponse.created(res, { connection: created });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
