/**
 * Write-Off Actions API
 * POST — approve, cancel
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  approveWriteOff,
  cancelWriteOff,
  WriteOffNotApprovableError,
} from '@/modules/accounting/services/ar/writeOffService';

const WriteOffActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), id: UUID }),
  z.object({ action: z.literal('cancel'), id: UUID }),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

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
    log.error('Write-off action failed', { error: err }, 'accounting-api');
    // Only refusals raised BEFORE the first posting may be answered with a 4xx:
    // `withAuth` COMMITs anything below 500, so the blanket badRequestFromError
    // this replaced committed a half-approved write-off — a posted journal with
    // the invoice not updated — and reported it as a 400.
    if (err instanceof WriteOffNotApprovableError) {
      return apiResponse.conflict(res, err.message);
    }
    if (err instanceof Error && /^Write-off not found/.test(err.message)) {
      return apiResponse.notFound(res, 'Write-off');
    }
    throw err;
  }
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
