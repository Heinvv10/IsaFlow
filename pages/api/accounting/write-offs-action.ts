/**
 * Write-Off Actions API
 * POST — approve, cancel
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { approveWriteOff, cancelWriteOff } from '@/modules/accounting/services/ar/writeOffService';

const WriteOffActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), id: UUID }),
  z.object({ action: z.literal('cancel'), id: UUID }),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;

  const parsed = WriteOffActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  try {
    const userId = req.user.id;

    switch (parsed.data.action) {
      case 'approve': {
        const item = await approveWriteOff(companyId, parsed.data.id, userId);
        return apiResponse.success(res, item);
      }
      case 'cancel':
        await cancelWriteOff(companyId, parsed.data.id);
        return apiResponse.success(res, { status: 'cancelled' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Action failed';
    log.error('Write-off action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, msg);
  }
}


export default withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))));
