/**
 * GET  /api/payroll/uif        — list UIF declarations (optional ?year=)
 * POST /api/payroll/uif        — generate declaration for a period
 *   body: { year: number, month: number }
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import {
  listUifDeclarations,
  generateUifDeclaration,
} from '@/modules/accounting/services/payroll/uifDeclarationService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { year } = req.query as Record<string, string | undefined>;
    const declarations = await listUifDeclarations(companyId, {
      year: year ? Number(year) : undefined,
    });
    return apiResponse.success(res, declarations);
  }

  if (req.method === 'POST') {
    const { year, month } = req.body as Record<string, unknown>;

    if (year == null || month == null) {
      return apiResponse.badRequest(res, 'year and month are required');
    }

    const y = Number(year);
    const m = Number(month);

    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      return apiResponse.badRequest(res, 'year must be a valid integer between 2000 and 2100');
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      return apiResponse.badRequest(res, 'month must be an integer between 1 and 12');
    }

    const declaration = await generateUifDeclaration(companyId, y, m, user.id);
    return apiResponse.created(res, declaration);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
