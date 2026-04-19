/**
 * GET   /api/payroll/uif/[id] — get declaration detail with employee lines
 * PATCH /api/payroll/uif/[id] — mark declaration as submitted
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const updated = await markUifSubmitted(companyId, id, user.id);
    if (!updated) return apiResponse.notFound(res, 'UIF declaration', id);
    return apiResponse.success(res, updated);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
