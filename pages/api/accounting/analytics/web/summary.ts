import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  getOverview,
  getPageviewsTimeseries,
  getTopPages,
  getTopReferrers,
  getBreakdown,
  type Range,
} from '@/modules/analytics/services/queryService';

const VALID_RANGES: Range[] = ['24h', '7d', '30d', '90d'];

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const websiteId = (req.query.website_id as string) || '';
  const range = ((req.query.range as string) || '7d') as Range;
  if (!websiteId) return apiResponse.badRequest(res, 'website_id required');
  if (!VALID_RANGES.includes(range)) return apiResponse.badRequest(res, 'invalid range');

  const cid = req.companyId;
  const [overview, timeseries, topPages, topReferrers, countries, devices, browsers] = await Promise.all([
    getOverview(websiteId, range, cid),
    getPageviewsTimeseries(websiteId, range, cid),
    getTopPages(websiteId, range, cid, 15),
    getTopReferrers(websiteId, range, cid, 15),
    getBreakdown(websiteId, 'country', range, cid),
    getBreakdown(websiteId, 'device', range, cid),
    getBreakdown(websiteId, 'browser', range, cid),
  ]);

  if (!overview) return apiResponse.notFound(res, 'website');

  return apiResponse.success(res, {
    overview,
    timeseries: timeseries ?? [],
    top_pages: topPages ?? [],
    top_referrers: topReferrers ?? [],
    countries: countries ?? [],
    devices: devices ?? [],
    browsers: browsers ?? [],
  });
}

export default withAuth(withErrorHandler(handler));
