import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import {
  getOverview,
  getPageviewsTimeseries,
  getTopPages,
  getTopReferrers,
  getTrafficSources,
  getBreakdown,
  type Range,
  type BreakdownDimension,
} from '@/modules/analytics/services/queryService';
import type { PlatformAdminRequest } from '@/lib/auth';

const VALID_RANGES: Range[] = ['24h', '7d', '30d', '90d'];

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const websiteId = (req.query.website_id as string) || '';
  const range = ((req.query.range as string) || '7d') as Range;
  if (!websiteId) return apiResponse.badRequest(res, 'website_id required');
  if (!VALID_RANGES.includes(range)) return apiResponse.badRequest(res, 'invalid range');

  const [overview, timeseries, topPages, topReferrers, trafficSources, countries, devices, browsers] = await Promise.all([
    getOverview(websiteId, range),
    getPageviewsTimeseries(websiteId, range),
    getTopPages(websiteId, range, null, 15),
    getTopReferrers(websiteId, range, null, 15),
    getTrafficSources(websiteId, range, null, 15),
    getBreakdown(websiteId, 'country' as BreakdownDimension, range),
    getBreakdown(websiteId, 'device' as BreakdownDimension, range),
    getBreakdown(websiteId, 'browser' as BreakdownDimension, range),
  ]);

  if (!overview) return apiResponse.notFound(res, 'website');

  return apiResponse.success(res, {
    overview,
    timeseries: timeseries ?? [],
    top_pages: topPages ?? [],
    top_referrers: topReferrers ?? [],
    traffic_sources: trafficSources ?? [],
    countries: countries ?? [],
    devices: devices ?? [],
    browsers: browsers ?? [],
  });
}

export default withAdmin(handler);
