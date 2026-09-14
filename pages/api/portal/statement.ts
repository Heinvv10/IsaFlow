/**
 * Client Portal — Statement API
 * GET — get client statement
 * Requires signed portal session cookie (JWT)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getClientStatement } from '@/modules/accounting/services/ar/portalService';
import { verifyArPortalToken, type ArPortalSession } from '@/lib/auth/arPortalJwt';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import cookie from 'cookie';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function getPortalSession(req: NextApiRequest): Promise<ArPortalSession | null> {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies.portal_session;
  if (!token) return null;
  return verifyArPortalToken(token);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const session = await getPortalSession(req);
  if (!session) {
    return apiResponse.unauthorized(res, 'Portal authentication required');
  }

  const clientId = req.query.clientId as string;
  if (!clientId) {
    return apiResponse.badRequest(res, 'clientId is required');
  }

  if (session.clientId !== clientId) {
    return apiResponse.forbidden(res, 'Access denied — clientId mismatch');
  }

  // R-095 L3: `asOf` used to default via toISOString().slice(0,10), which
  // rolls back a day between 00:00 and 02:00 SAST on this UTC+2 host (same
  // defect fmtDate.ts documents for DB dates) — asAtTodayStr() uses local
  // calendar getters instead. An unvalidated value also let a malformed or
  // repeated (array) asOf reach Postgres and 500 instead of 400.
  const asOfParam = req.query.asOf;
  if (Array.isArray(asOfParam)) {
    return apiResponse.badRequest(res, 'asOf must be a single date');
  }
  let asOfDate = asAtTodayStr();
  if (asOfParam) {
    if (!ISO_DATE_RE.test(asOfParam) || isNaN(new Date(`${asOfParam}T00:00:00Z`).getTime())) {
      return apiResponse.badRequest(res, 'asOf must be a valid YYYY-MM-DD date');
    }
    asOfDate = asOfParam;
  }
  const statement = await getClientStatement(clientId, session.companyId, asOfDate);
  if (!statement) {
    return apiResponse.notFound(res, 'Customer', clientId);
  }
  return apiResponse.success(res, statement);
}

export default withErrorHandler(handler);
