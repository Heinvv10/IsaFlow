/**
 * Intercompany connections (P1).
 * GET  — this company's connections, each with its own side and setup checklist
 * POST — create a GROUP connection with another member of one of this company's groups
 *        body: { partnerCompanyId }
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { createGroupConnection, listConnections } from '@/modules/accounting/services/intercompany/connectionService';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { parseCreateInput } from '@/modules/accounting/services/intercompany/connectionValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const items = await listConnections(req.companyId);
    return apiResponse.success(res, { items, count: items.length });
  }

  if (req.method === 'POST') {
    const parsed = parseCreateInput(req.body);
    if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
    try {
      const connection = await createGroupConnection(req.user.id, req.companyId, parsed.partnerCompanyId);
      return apiResponse.success(res, connection, 'Connection created', 201);
    } catch (err) {
      if (respondIfRefusal(res, err)) return;
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
