/**
 * /api/accounting/ar/sent-mirror/connections/[id]
 *   PATCH  — update sent_folder / scan interval
 *   DELETE — hard-delete (scan log rows cascade)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import {
  updateSentConnection,
  deleteSentConnection,
} from '@/modules/accounting/services/ar/sentMirrorAdmin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UpdateBody {
  sentFolder?: string;
  scanIntervalMinutes?: number;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const id = req.query.id as string;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Sent mirror connection', id);

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as UpdateBody;
    const updated = await updateSentConnection({
      id, companyId,
      sentFolder: body.sentFolder,
      scanIntervalMinutes: body.scanIntervalMinutes,
    });
    if (!updated) return apiResponse.notFound(res, 'Sent mirror connection', id);
    return apiResponse.success(res, { connection: updated });
  }

  if (req.method === 'DELETE') {
    const removed = await deleteSentConnection(id, companyId);
    if (!removed) return apiResponse.notFound(res, 'Sent mirror connection', id);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['PATCH', 'DELETE']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
