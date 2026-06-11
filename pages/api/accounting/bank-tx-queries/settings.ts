/**
 * GET  /api/accounting/bank-tx-queries/settings → { clientQueryWhatsapp, companyName }
 * PATCH /api/accounting/bank-tx-queries/settings { clientQueryWhatsapp: string | null }
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getQuerySettings,
  saveQuerySettings,
} from '@/modules/accounting/services/capture/bankTxQueryService';

const BodySchema = z.object({ clientQueryWhatsapp: z.string().max(30).nullable() }).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  if (req.method === 'GET') {
    return apiResponse.success(res, await getQuerySettings(companyId));
  }
  if (req.method === 'PATCH') {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const result = await saveQuerySettings(companyId, parsed.data.clientQueryWhatsapp);
    if (!result.ok) return apiResponse.badRequest(res, result.reason ?? 'invalid');
    return apiResponse.success(res, await getQuerySettings(companyId));
  }
  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
