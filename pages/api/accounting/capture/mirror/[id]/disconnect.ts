/**
 * POST /api/accounting/capture/mirror/[id]/disconnect
 * Marks the connection disconnected and wipes stored credentials.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { disconnectConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Mirror connection', id);

  const ok = await disconnectConnection(id, companyId);
  if (!ok) return apiResponse.notFound(res, 'Mirror connection', id);
  return apiResponse.success(res, { disconnected: true });
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
