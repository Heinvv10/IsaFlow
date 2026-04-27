/**
 * POST /api/admin/billing/payg/[companyId]/adjust
 * Manually credit or debit a company's Flow balance.
 * Records an `admin_adjustment` ledger row with the provided reason.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { adminAdjust, InsufficientFlowsError } from '@/modules/billing/services/flowWalletService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';

const Body = z.object({
  flows:  z.number().int().refine((v) => v !== 0, 'flows must be non-zero'),
  reason: z.string().min(3).max(500),
}).strict();

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req.query;
  if (typeof companyId !== 'string' || !companyId) {
    return apiResponse.badRequest(res, 'companyId is required');
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  try {
    const result = await adminAdjust(companyId, parsed.data.flows, parsed.data.reason);
    await logAdminAction(
      req.user.id,
      'flow.adjust',
      'company',
      companyId,
      { flows: parsed.data.flows, reason: parsed.data.reason, balanceAfter: result.balanceAfter },
      getIp(req),
    );
    return apiResponse.success(res, result, 'Wallet adjusted');
  } catch (err) {
    if (err instanceof InsufficientFlowsError) {
      return apiResponse.badRequest(res, 'Adjustment would leave a negative balance');
    }
    throw err;
  }
}

export default withAdmin(withCsrf(handler));
