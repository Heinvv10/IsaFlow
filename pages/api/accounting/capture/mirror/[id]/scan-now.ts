/**
 * POST /api/accounting/capture/mirror/[id]/scan-now
 * Fires a one-off scan of the connection ignoring the interval gate.
 * Returns the scan summary (scanned / ingested / skipped / errors). Runs under a 30 s
 * deadline; 409 while a scan of this connection or another scan-now of this company is running.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { getConnection, scanConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { runScanNow, ScanNowBusyError } from '@/modules/accounting/services/capture/mirrorScanNow';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Mirror connection', id);

  const conn = await getConnection(id, companyId);
  if (!conn) return apiResponse.notFound(res, 'Mirror connection', id);

  try {
    return apiResponse.success(res, await runScanNow(conn, (opts) => scanConnection(conn, opts)));
  } catch (err) {
    if (err instanceof ScanNowBusyError) return apiResponse.conflict(res, err.message, { reason: err.reason });
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
