/**
 * PUT — the pair's agreement on one connection: { settlementMode?, cutoverDate?, interestRatePct? }. A key left
 * out is unchanged; null clears. A group connection's change needs a write role in BOTH companies.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { updateConnectionSettings } from '@/modules/accounting/services/intercompany/connectionService';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { parsePairInput } from '@/modules/accounting/services/intercompany/connectionValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? '', ['PUT']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  const parsed = parsePairInput(req.body);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  try {
    return apiResponse.success(res, await updateConnectionSettings(req.user.id, req.companyId, id.toLowerCase(), parsed.value), 'Settings saved');
  } catch (err) {
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
