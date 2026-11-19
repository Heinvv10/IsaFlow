/**
 * Pre-cut-over pairing of one intercompany connection (P3).
 * GET  ?direction=ar|ap — the screen's data: this company's open documents dated before the cut-over against the partner's
 *      (number, date, total, open amount only), suggested pairs, exceptions, pairings already made, the loan-balance difference.
 * POST { direction, pairs: [{ mineId, theirsId }] } — record the pairs as document links. Never posts anything.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { createPairings } from '@/modules/accounting/services/intercompany/pairingWrite';
import { parseDirection, parsePairsInput } from '@/modules/accounting/services/intercompany/pairingValidation';
import { buildPairingView } from '@/modules/accounting/services/intercompany/pairingView';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  const connectionId = id.toLowerCase();

  try {
    if (req.method === 'GET') {
      const dir = parseDirection(req.query.direction);
      if (!dir.ok) return apiResponse.badRequest(res, dir.error);
      return apiResponse.success(res, await buildPairingView(req.user.id, req.companyId, connectionId, dir.direction));
    }
    const parsed = parsePairsInput(req.body);
    if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
    const result = await createPairings(req.user.id, req.companyId, connectionId, parsed.direction, parsed.pairs);
    return apiResponse.success(res, result, 'Pairings recorded', 201);
  } catch (err) {
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
