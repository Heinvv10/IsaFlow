/**
 * GET /api/payroll/equity/occupational-levels — global master list.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { listOccupationalLevels } from '@/modules/accounting/services/payroll/equityReportService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const rows = await listOccupationalLevels();
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
