/**
 * POST /api/track/event — public, unauthenticated pageview/event ingest.
 * Called by public/isa-track.js from every page that injects the tracker.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { ingestEvent } from '@/modules/analytics/services/trackingService';
import { extractCountry } from '@/modules/analytics/utils/fingerprint';

function str(v: unknown, max = 1000): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`track:${ip}`, { windowSecs: 60, max: 120 });
  if (!allowed) return apiResponse.tooManyRequests(res, 'Rate limit exceeded');

  const body = req.body || {};
  const trackingId = str(body.t, 64);
  const urlPath = str(body.p, 500);
  if (!trackingId || !urlPath) {
    return apiResponse.badRequest(res, 'Missing required fields');
  }

  const eventType = body.e === 'custom' ? 'custom' : 'pageview';
  const userAgent = str(req.headers['user-agent'], 500) || 'unknown';

  try {
    const result = await ingestEvent({
      trackingId,
      urlPath,
      urlQuery: str(body.q, 500),
      referrer: str(body.r, 1000),
      screen: str(body.s, 32),
      lang: str(body.l, 16),
      pageTitle: str(body.ti, 200),
      eventType,
      eventName: eventType === 'custom' ? str(body.n, 100) : null,
      eventData: (body.d && typeof body.d === 'object') ? body.d as Record<string, unknown> : null,
      userId: str(body.u, 255),
      ip,
      userAgent,
      country: extractCountry(req.headers),
    });

    if (!result) return apiResponse.success(res, { ok: false, reason: 'unknown_tracking_id' });
    return apiResponse.success(res, { ok: true });
  } catch (err) {
    log.error('Analytics ingest failed', { error: String(err) }, 'track-api');
    return apiResponse.success(res, { ok: false });
  }
}
