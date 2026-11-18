/**
 * One intercompany connection.
 * PUT    — edit THIS company's own side (customer, supplier, settlement mode, loan account, default expense
 *          account, auto-accept (group only), cut-over date, interest rate). A body key left out is unchanged;
 *          null clears.
 * DELETE — revoke the connection (either party).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { revokeConnection, updateOwnSide } from '@/modules/accounting/services/intercompany/connectionService';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { parseSideInput } from '@/modules/accounting/services/intercompany/connectionValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  const connectionId = id.toLowerCase();

  try {
    if (req.method === 'PUT') {
      const parsed = parseSideInput(req.body);
      if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
      return apiResponse.success(res, await updateOwnSide(req.companyId, connectionId, parsed.value), 'Settings saved');
    }
    if (req.method === 'DELETE') {
      return apiResponse.success(res, await revokeConnection(req.companyId, connectionId), 'Connection revoked');
    }
  } catch (err) {
    if (respondIfRefusal(res, err)) return;
    throw err;
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
