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
// R-095 round 3 (HIGH-1): `import cookie from 'cookie'` gives `undefined`
// under Next's webpack build (the package is CJS with no `default` export) —
// every one of these routes 500'd on every real request. Named import.
import { parse } from 'cookie';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * R-095 round 3 (MEDIUM-3): `new Date('2026-02-31T00:00:00Z')` does not
 * return Invalid Date — it ROLLS OVER to 3 March, so `!isNaN(...)` admitted
 * a calendar-invalid date and it reached a `::date` comparison in Postgres,
 * which does reject it, so the route still 500'd (the exact defect L3
 * claimed to have closed). Reconstructing the date from its own y/m/d and
 * checking Date.UTC's normalised output still equals the input catches the
 * rollover directly, instead of trusting `Date` to reject what it silently
 * "fixes".
 */
function isValidIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

async function getPortalSession(req: NextApiRequest): Promise<ArPortalSession | null> {
  const cookies = parse(req.headers.cookie || '');
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
    if (!isValidIsoDate(asOfParam)) {
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
