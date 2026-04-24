import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { visitorHash, sessionHash } from '../utils/fingerprint';
import { parseUserAgent, parseReferrer, parseUtm } from '../utils/userAgent';

export interface IngestEventInput {
  trackingId: string;
  urlPath: string;
  urlQuery?: string | null;
  referrer?: string | null;
  screen?: string | null;
  lang?: string | null;
  eventType?: 'pageview' | 'custom';
  eventName?: string | null;
  eventData?: Record<string, unknown> | null;
  userId?: string | null;
  ip: string;
  userAgent: string;
  country?: string | null;
}

export interface IngestResult {
  ok: boolean;
  websiteId: string;
  sessionId: string;
}

export async function ingestEvent(input: IngestEventInput): Promise<IngestResult | null> {
  const websiteRows = await sql`
    SELECT id FROM analytics_websites WHERE tracking_id = ${input.trackingId}
  `;
  const website = websiteRows[0] as DbRow | undefined;
  if (!website) {
    log.warn('Tracker hit for unknown tracking_id', { trackingId: input.trackingId }, 'trackingService');
    return null;
  }
  const websiteId = website.id as string;

  const sHash = sessionHash(input.ip, input.userAgent, websiteId);
  const vHash = visitorHash(input.ip, input.userAgent);
  const { device, browser, os } = parseUserAgent(input.userAgent);
  const { domain: refDomain, path: refPath } = parseReferrer(input.referrer);
  const utm = parseUtm(input.urlQuery);

  const upserted = await sql`
    INSERT INTO analytics_sessions (
      website_id, session_hash, visitor_hash, user_id,
      country, device, browser, os, screen, lang,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      first_seen, last_seen
    )
    VALUES (
      ${websiteId}, ${sHash}, ${vHash}, ${input.userId ?? null},
      ${input.country ?? null}, ${device}, ${browser}, ${os},
      ${input.screen ?? null}, ${input.lang ?? null},
      ${utm.source}, ${utm.medium}, ${utm.campaign}, ${utm.term}, ${utm.content},
      NOW(), NOW()
    )
    ON CONFLICT (website_id, session_hash) DO UPDATE
      SET last_seen    = NOW(),
          user_id      = COALESCE(analytics_sessions.user_id,      EXCLUDED.user_id),
          utm_source   = COALESCE(analytics_sessions.utm_source,   EXCLUDED.utm_source),
          utm_medium   = COALESCE(analytics_sessions.utm_medium,   EXCLUDED.utm_medium),
          utm_campaign = COALESCE(analytics_sessions.utm_campaign, EXCLUDED.utm_campaign),
          utm_term     = COALESCE(analytics_sessions.utm_term,     EXCLUDED.utm_term),
          utm_content  = COALESCE(analytics_sessions.utm_content,  EXCLUDED.utm_content)
    RETURNING id
  `;
  const sessionRow = upserted[0] as DbRow | undefined;
  if (!sessionRow) return null;
  const sessionId = sessionRow.id as string;

  await sql`
    INSERT INTO analytics_events (
      website_id, session_id, event_type,
      url_path, url_query, referrer_domain, referrer_path,
      event_name, event_data
    )
    VALUES (
      ${websiteId}, ${sessionId}, ${input.eventType ?? 'pageview'},
      ${input.urlPath}, ${input.urlQuery ?? null}, ${refDomain}, ${refPath},
      ${input.eventName ?? null}, ${input.eventData ? JSON.stringify(input.eventData) : null}
    )
  `;

  return { ok: true, websiteId, sessionId };
}

export async function registerPortalWebsite(companyId: string, companyName: string): Promise<string> {
  const existing = await sql`
    SELECT tracking_id FROM analytics_websites
    WHERE company_id = ${companyId} AND category = 'portal'
    LIMIT 1
  `;
  const first = existing[0] as DbRow | undefined;
  if (first) return first.tracking_id as string;

  const trackingId = `isa_portal_${companyId.replace(/-/g, '').slice(0, 12)}`;
  await sql`
    INSERT INTO analytics_websites (company_id, name, tracking_id, category, domain)
    VALUES (${companyId}, ${`${companyName} Portal`}, ${trackingId}, 'portal', 'app.isaflow.co.za')
    ON CONFLICT (tracking_id) DO NOTHING
  `;
  return trackingId;
}
