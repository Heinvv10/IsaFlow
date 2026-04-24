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
  getEntryPages,
  getExitPages,
  getCustomEvents,
  getChannels,
  type Range,
} from '@/modules/analytics/services/queryService';
import type { PlatformAdminRequest } from '@/lib/auth';

const VALID_RANGES: Range[] = ['24h', '7d', '30d', '90d'];

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const websiteId = (req.query.website_id as string) || '';
  const range = ((req.query.range as string) || '7d') as Range;
  const includeBots = req.query.include_bots === '1';
  if (!websiteId) return apiResponse.badRequest(res, 'website_id required');
  if (!VALID_RANGES.includes(range)) return apiResponse.badRequest(res, 'invalid range');

  const [
    overview, timeseries, topPages, topReferrers, trafficSources, channels,
    entryPages, exitPages, customEvents,
    countries, devices, browsers, operatingSystems, languages,
  ] = await Promise.all([
    getOverview(websiteId, range, null, includeBots),
    getPageviewsTimeseries(websiteId, range),
    getTopPages(websiteId, range, null, 15),
    getTopReferrers(websiteId, range, null, 15),
    getTrafficSources(websiteId, range, null, 15),
    getChannels(websiteId, range),
    getEntryPages(websiteId, range, null, 15),
    getExitPages(websiteId, range, null, 15),
    getCustomEvents(websiteId, range, null, 15),
    getBreakdown(websiteId, 'country', range),
    getBreakdown(websiteId, 'device',  range),
    getBreakdown(websiteId, 'browser', range),
    getBreakdown(websiteId, 'os',      range),
    getBreakdown(websiteId, 'language', range),
  ]);

  if (!overview) return apiResponse.notFound(res, 'website');

  return apiResponse.success(res, {
    overview,
    timeseries:       timeseries       ?? [],
    top_pages:        topPages         ?? [],
    top_referrers:    topReferrers     ?? [],
    traffic_sources:  trafficSources   ?? [],
    channels:         channels         ?? [],
    entry_pages:      entryPages       ?? [],
    exit_pages:       exitPages        ?? [],
    custom_events:    customEvents     ?? [],
    countries:        countries        ?? [],
    devices:          devices          ?? [],
    browsers:         browsers         ?? [],
    operating_systems: operatingSystems ?? [],
    languages:        languages        ?? [],
  });
}

export default withAdmin(handler);
