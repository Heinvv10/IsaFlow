/**
 * GET   /api/payroll/uif/[id] — get declaration detail with employee lines
 * PATCH /api/payroll/uif/[id] — mark submitted OR paid
 *   body { markSubmitted: true }               → markUifSubmitted
 *   body { markPaid: true, paymentDate?, bankAccountId? } → markUifDeclarationPaid
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import {
  getUifDeclaration,
  markUifSubmitted,
} from '@/modules/accounting/services/payroll/uifDeclarationService';
import { markUifDeclarationPaid } from '@/modules/accounting/services/payroll/uifPaymentService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PatchBody {
  markSubmitted?: boolean;
  markPaid?: boolean;
  paymentDate?: string;
  bankAccountId?: string;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id);

  if (!UUID_RE.test(id)) return apiResponse.notFound(res, 'UIF declaration', id);

  if (req.method === 'GET') {
    const declaration = await getUifDeclaration(companyId, id);
    if (!declaration) return apiResponse.notFound(res, 'UIF declaration', id);
    return apiResponse.success(res, declaration);
  }

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as PatchBody;

    if (body.markPaid === true) {
      const result = await markUifDeclarationPaid(
        companyId,
        id,
        {
          paymentDate: body.paymentDate,
          bankAccountId: body.bankAccountId,
        },
        user.id,
      );
      return apiResponse.success(res, result);
    }

    if (body.markSubmitted === true) {
      const updated = await markUifSubmitted(companyId, id, user.id);
      if (!updated) return apiResponse.notFound(res, 'UIF declaration', id);
      return apiResponse.success(res, updated);
    }

    return apiResponse.badRequest(res, 'unknown patch operation — send markSubmitted or markPaid');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
