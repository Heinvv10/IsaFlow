/**
 * /api/accounting/capture/mirror/[id]
 *   PATCH  — update senders / folder / scan interval
 *   DELETE — hard-delete the connection (also removes scan log rows via FK cascade)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import {
  updateConnectionSenders,
  deleteConnection,
} from '@/modules/accounting/services/capture/mirrorConnectionService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UpdateBody {
  allowedSenders?: string[];
  deniedSenders?: string[];
  scanIntervalMinutes?: number;
  folder?: string;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const id = req.query.id as string;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Mirror connection', id);

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as UpdateBody;
    const updated = await updateConnectionSenders({
      id, companyId,
      allowedSenders: body.allowedSenders,
      deniedSenders: body.deniedSenders,
      scanIntervalMinutes: body.scanIntervalMinutes,
      folder: body.folder,
    });
    if (!updated) return apiResponse.notFound(res, 'Mirror connection', id);
    return apiResponse.success(res, { connection: updated });
  }

  if (req.method === 'DELETE') {
    const removed = await deleteConnection(id, companyId);
    if (!removed) return apiResponse.notFound(res, 'Mirror connection', id);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['PATCH', 'DELETE']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
