/**
 * PATCH /api/accounting/bank-tx-queries/[id]
 *   Body: { action: 'resolve' | 'cancel' }
 *   resolve: allowed from sent|replied. cancel: allowed from sent only.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { setQueryStatus } from '@/modules/accounting/services/capture/bankTxQueryService';

const BodySchema = z.object({ action: z.enum(['resolve', 'cancel']) }).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  if (req.method !== 'PATCH') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH']);
  }
  const id = UUID.safeParse(req.query.id);
  if (!id.success) return apiResponse.badRequest(res, 'invalid id');
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const result = await setQueryStatus(companyId, id.data, parsed.data.action);
  if (!result.ok) {
    if (result.reason === 'not found') return apiResponse.notFound(res, 'Bank-tx query', id.data);
    return apiResponse.badRequest(res, result.reason ?? 'invalid state');
  }
  return apiResponse.success(res, { id: id.data, action: parsed.data.action });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
