/**
 * /api/accounting/ar/sent-mirror/connections/[id]
 *   PATCH  — update sent_folder / scan interval
 *   DELETE — hard-delete (scan log rows cascade)
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import {
  updateSentConnection,
  deleteSentConnection,
} from '@/modules/accounting/services/ar/sentMirrorAdmin';

const UpdateSchema = z.object({
  sentFolder: z.string().max(200).optional(),
  scanIntervalMinutes: z.number().int().min(1).max(1440).optional(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const idParse = UUID.safeParse(req.query.id);
  if (!idParse.success) return apiResponse.notFound(res, 'Sent mirror connection', String(req.query.id ?? ''));
  const id = idParse.data;

  if (req.method === 'PATCH') {
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const updated = await updateSentConnection({
      id, companyId,
      sentFolder: parsed.data.sentFolder,
      scanIntervalMinutes: parsed.data.scanIntervalMinutes,
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

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
