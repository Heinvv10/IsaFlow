/**
 * GET /api/accounting/packs/[id]/trend?to=YYYY-MM-DD&months=12
 *
 * The twelve-month series behind a pack's trend chart. Its own route (rather
 * than a field on reports-pack) because the printed page fetches it as a
 * second authorised path — see packPrintApiPaths.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { getPackTrend } from '@/modules/accounting/services/packs/packTrendService';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The series is a TWELVE-month trend; `monthSlots` clamps anything outside
 *  1..12 to that range. Clamping silently is how `months=999` came back as a
 *  12-point series that the caller had every reason to read as 999 months of
 *  history, and `months=1.5` as a 1-point one. The route says no instead. */
const MIN_MONTHS = 1;
const MAX_MONTHS = 12;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!VALID_TYPES.includes(id as PackType)) {
    return apiResponse.badRequest(res, `id must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const to = String(req.query.to ?? '');
  if (!ISO_DATE.test(to)) return apiResponse.badRequest(res, 'to must be a YYYY-MM-DD date');

  const months = Number(req.query.months ?? MAX_MONTHS);
  if (!Number.isInteger(months) || months < MIN_MONTHS || months > MAX_MONTHS) {
    return apiResponse.badRequest(res, `months must be a whole number from ${MIN_MONTHS} to ${MAX_MONTHS}`);
  }

  if (!(await checkReportRateLimit(companyId, 'packs-trend'))) {
    log.warn('Pack trend rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report requests. Please try again shortly.');
  }

  return apiResponse.success(res, await getPackTrend(companyId, to, months));
}

export default withAuth(withErrorHandler(handler as never));
