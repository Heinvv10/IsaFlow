/**
 * One pairing (document link) of an intercompany connection (P3).
 * PUT    — confirm the pairing the partner proposed (this company's side). It becomes active; nothing is posted.
 * DELETE — unlink it (either party); both documents can be paired again. Nothing is posted or reversed.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { confirmPairing, unlinkPairing } from '@/modules/accounting/services/intercompany/pairingWrite';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'PUT' && req.method !== 'DELETE') return apiResponse.methodNotAllowed(res, req.method ?? '', ['PUT', 'DELETE']);
  const { id, linkId } = req.query;
  if (!isUuidParam(id) || !isUuidParam(linkId)) return apiResponse.badRequest(res, 'id and linkId must be valid UUIDs');
  try {
    if (req.method === 'PUT') {
      return apiResponse.success(res, await confirmPairing(req.user.id, req.companyId, id.toLowerCase(), linkId.toLowerCase()), 'Pairing confirmed');
    }
    return apiResponse.success(res, await unlinkPairing(req.user.id, req.companyId, id.toLowerCase(), linkId.toLowerCase()), 'Pairing removed');
  } catch (err) {
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
