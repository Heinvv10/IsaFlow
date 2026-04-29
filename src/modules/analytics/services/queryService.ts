import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export type Range = '24h' | '7d' | '30d' | '90d';

const RANGE_INTERVAL: Record<Range, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

const RANGE_BUCKET: Record<Range, string> = {
  '24h': 'hour',
  '7d':  'day',
  '30d': 'day',
  '90d': 'week',
};

export interface WebsiteSummary {
  id: string;
  name: string;
  tracking_id: string;
  domain: string | null;
  category: string;
  company_id: string | null;
}

export async function listWebsites(companyId?: string | null): Promise<WebsiteSummary[]> {
  const rows = companyId
    ? await sql`
        SELECT id, name, tracking_id, domain, category, company_id
        FROM analytics_websites
        WHERE company_id = ${companyId}
        ORDER BY category, name
      `
    : await sql`
        SELECT id, name, tracking_id, domain, category, company_id
        FROM analytics_websites
        ORDER BY company_id NULLS FIRST, category, name
      `;
  return rows as WebsiteSummary[];
}

async function requireWebsite(websiteId: string, companyId?: string | null): Promise<WebsiteSummary | null> {
  const rows = await sql`
    SELECT id, name, tracking_id, domain, category, company_id
    FROM analytics_websites
    WHERE id = ${websiteId}
    LIMIT 1
  `;
  const w = rows[0] as WebsiteSummary | undefined;
  if (!w) return null;
  if (companyId && w.company_id !== companyId) return null;
  return w;
}

export interface RealtimeStats {
  active_users_5m: number;
  pageviews_5m: number;
  top_paths_5m: Array<{ path: string; views: number }>;
}

export async function getRealtime(websiteId: string, companyId?: string | null): Promise<RealtimeStats | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;

  const [activeRows, viewRows, pathRows] = await Promise.all([
    sql`
      SELECT COUNT(DISTINCT s.id)::int AS n
      FROM analytics_sessions s
      WHERE s.website_id = ${websiteId}
        AND s.is_bot = false
        AND s.last_seen >= NOW() - INTERVAL '5 minutes'
    `,
    sql`
      SELECT COUNT(*)::int AS n
      FROM analytics_events e
      JOIN analytics_sessions s ON s.id = e.session_id
      WHERE e.website_id = ${websiteId}
        AND s.is_bot = false
        AND e.created_at >= NOW() - INTERVAL '5 minutes'
    `,
    sql`
      SELECT e.url_path AS path, COUNT(*)::int AS views
      FROM analytics_events e
      JOIN analytics_sessions s ON s.id = e.session_id
      WHERE e.website_id = ${websiteId}
        AND s.is_bot = false
        AND e.created_at >= NOW() - INTERVAL '5 minutes'
      GROUP BY e.url_path
      ORDER BY views DESC
      LIMIT 5
    `,
  ]);

  const a = activeRows[0] as DbRow | undefined;
  const v = viewRows[0] as DbRow | undefined;
  return {
    active_users_5m: (a?.n as number) ?? 0,
    pageviews_5m: (v?.n as number) ?? 0,
    top_paths_5m: pathRows as Array<{ path: string; views: number }>,
  };
}

export interface TimeseriesPoint {
  bucket: string;
  pageviews: number;
  sessions: number;
  visitors: number;
}

export async function getPageviewsTimeseries(
  websiteId: string,
  range: Range,
  companyId?: string | null
): Promise<TimeseriesPoint[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;

  const interval = RANGE_INTERVAL[range];
  const bucket = RANGE_BUCKET[range];

  const rows = await sql`
    WITH events_win AS (
      SELECT
        date_trunc(${bucket}, e.created_at) AS bucket,
        e.session_id
      FROM analytics_events e
      JOIN analytics_sessions s ON s.id = e.session_id
      WHERE e.website_id = ${websiteId}
        AND s.is_bot = false
        AND e.created_at >= NOW() - (${interval})::interval
    ),
    sess_win AS (
      SELECT id, visitor_hash,
             date_trunc(${bucket}, first_seen) AS bucket
      FROM analytics_sessions
      WHERE website_id = ${websiteId}
        AND is_bot = false
        AND first_seen >= NOW() - (${interval})::interval
    )
    SELECT
      COALESCE(e.bucket, s.bucket)           AS bucket,
      COALESCE(COUNT(e.session_id), 0)::int  AS pageviews,
      COUNT(DISTINCT s.id)::int              AS sessions,
      COUNT(DISTINCT s.visitor_hash)::int    AS visitors
    FROM events_win e
    FULL OUTER JOIN sess_win s ON s.bucket = e.bucket
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  return rows.map((r: DbRow) => ({
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
    pageviews: r.pageviews as number,
    sessions: r.sessions as number,
    visitors: r.visitors as number,
  }));
}

export interface TopPageRow {
  path: string;
  title: string | null;
  views: number;
  sessions: number;
}

export async function getTopPages(
  websiteId: string,
  range: Range,
  companyId?: string | null,
  limit = 20
): Promise<TopPageRow[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;

  const interval = RANGE_INTERVAL[range];
  // Title resolution: pick the earliest non-null page_title for the path
  // (deterministic and matches what the page was titled when first indexed
  // in this window). MAX(page_title) — used elsewhere — is lexicographically
  // arbitrary across events for the same path.
  const rows = await sql`
    SELECT e.url_path AS path,
           (array_agg(e.page_title ORDER BY e.created_at ASC)
              FILTER (WHERE e.page_title IS NOT NULL))[1] AS title,
           COUNT(*)::int                     AS views,
           COUNT(DISTINCT e.session_id)::int AS sessions
    FROM analytics_events e
    JOIN analytics_sessions s ON s.id = e.session_id
    WHERE e.website_id = ${websiteId}
      AND s.is_bot = false
      AND e.created_at >= NOW() - (${interval})::interval
      AND e.event_type = 'pageview'
    GROUP BY e.url_path
    ORDER BY views DESC
    LIMIT ${limit}
  `;
  return rows as TopPageRow[];
}

export interface TrafficSourceRow {
  source: string;
  medium: string | null;
  campaign: string | null;
  sessions: number;
}

export async function getTrafficSources(
  websiteId: string,
  range: Range,
  companyId?: string | null,
  limit = 20
): Promise<TrafficSourceRow[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;

  const interval = RANGE_INTERVAL[range];
  // Source priority: utm_source > referrer_domain > '(direct)'.
  // utm_source is captured at first-touch so the same session carries it across pageviews.
  const rows = await sql`
    WITH first_events AS (
      SELECT DISTINCT ON (s.id)
        s.id                      AS session_id,
        s.utm_source,
        s.utm_medium,
        s.utm_campaign,
        e.referrer_domain
      FROM analytics_sessions s
      LEFT JOIN analytics_events e
        ON e.session_id = s.id
      WHERE s.website_id = ${websiteId}
        AND s.is_bot = false
        AND s.first_seen >= NOW() - (${interval})::interval
      ORDER BY s.id, e.created_at ASC
    )
    SELECT
      COALESCE(utm_source, referrer_domain, '(direct)') AS source,
      utm_medium                                        AS medium,
      utm_campaign                                      AS campaign,
      COUNT(*)::int                                     AS sessions
    FROM first_events
    GROUP BY 1, 2, 3
    ORDER BY sessions DESC
    LIMIT ${limit}
  `;
  return rows as TrafficSourceRow[];
}

export interface TopReferrerRow {
  domain: string;
  views: number;
  sessions: number;
}

export async function getTopReferrers(
  websiteId: string,
  range: Range,
  companyId?: string | null,
  limit = 20
): Promise<TopReferrerRow[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;

  const interval = RANGE_INTERVAL[range];
  const rows = await sql`
    SELECT COALESCE(e.referrer_domain, '(direct)') AS domain,
           COUNT(*)::int                           AS views,
           COUNT(DISTINCT e.session_id)::int       AS sessions
    FROM analytics_events e
    JOIN analytics_sessions s ON s.id = e.session_id
    WHERE e.website_id = ${websiteId}
      AND s.is_bot = false
      AND e.created_at >= NOW() - (${interval})::interval
      AND e.event_type = 'pageview'
    GROUP BY COALESCE(e.referrer_domain, '(direct)')
    ORDER BY views DESC
    LIMIT ${limit}
  `;
  return rows as TopReferrerRow[];
}

export type BreakdownDimension = 'country' | 'device' | 'browser' | 'os' | 'language';

export interface BreakdownRow {
  label: string;
  sessions: number;
}

export async function getBreakdown(
  websiteId: string,
  dimension: BreakdownDimension,
  range: Range,
  companyId?: string | null
): Promise<BreakdownRow[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;

  const interval = RANGE_INTERVAL[range];
  const rows = dimension === 'country'
    ? await sql`
        SELECT COALESCE(country, 'Unknown') AS label, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE website_id = ${websiteId} AND is_bot = false AND first_seen >= NOW() - (${interval})::interval
        GROUP BY 1 ORDER BY sessions DESC LIMIT 20
      `
    : dimension === 'device'
    ? await sql`
        SELECT COALESCE(device, 'Unknown') AS label, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE website_id = ${websiteId} AND is_bot = false AND first_seen >= NOW() - (${interval})::interval
        GROUP BY 1 ORDER BY sessions DESC LIMIT 20
      `
    : dimension === 'browser'
    ? await sql`
        SELECT COALESCE(browser, 'Unknown') AS label, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE website_id = ${websiteId} AND is_bot = false AND first_seen >= NOW() - (${interval})::interval
        GROUP BY 1 ORDER BY sessions DESC LIMIT 20
      `
    : dimension === 'language'
    ? await sql`
        SELECT COALESCE(lang, 'Unknown') AS label, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE website_id = ${websiteId} AND is_bot = false AND first_seen >= NOW() - (${interval})::interval
        GROUP BY 1 ORDER BY sessions DESC LIMIT 20
      `
    : await sql`
        SELECT COALESCE(os, 'Unknown') AS label, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE website_id = ${websiteId} AND is_bot = false AND first_seen >= NOW() - (${interval})::interval
        GROUP BY 1 ORDER BY sessions DESC LIMIT 20
      `;

  return rows as BreakdownRow[];
}

export interface OverviewStats {
  range: Range;
  pageviews: number;
  sessions: number;
  visitors: number;
  bounce_rate_percent: number;
  avg_session_secs: number;
  views_per_session: number;
}

export async function getOverview(
  websiteId: string,
  range: Range,
  companyId?: string | null,
  includeBots = false
): Promise<OverviewStats | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;

  const interval = RANGE_INTERVAL[range];
  const rows = includeBots
    ? await sql`
        WITH sess AS (
          SELECT id, visitor_hash, EXTRACT(EPOCH FROM (last_seen - first_seen))::int AS dur
          FROM analytics_sessions
          WHERE website_id = ${websiteId} AND first_seen >= NOW() - (${interval})::interval
        ),
        ev AS (
          SELECT session_id, COUNT(*)::int AS views
          FROM analytics_events
          WHERE website_id = ${websiteId} AND created_at >= NOW() - (${interval})::interval
          GROUP BY session_id
        )
        SELECT
          COALESCE(SUM(ev.views), 0)::int                      AS pageviews,
          COUNT(DISTINCT sess.id)::int                         AS sessions,
          COUNT(DISTINCT sess.visitor_hash)::int               AS visitors,
          COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE ev.views = 1)
                         / NULLIF(COUNT(*), 0), 1), 0)::float  AS bounce_rate_percent,
          COALESCE(AVG(sess.dur), 0)::int                      AS avg_session_secs,
          COALESCE(ROUND(AVG(ev.views)::numeric, 2), 0)::float AS views_per_session
        FROM sess LEFT JOIN ev ON ev.session_id = sess.id
      `
    : await sql`
        WITH sess AS (
          SELECT id, visitor_hash, EXTRACT(EPOCH FROM (last_seen - first_seen))::int AS dur
          FROM analytics_sessions
          WHERE website_id = ${websiteId} AND is_bot = false AND first_seen >= NOW() - (${interval})::interval
        ),
        ev AS (
          SELECT e.session_id, COUNT(*)::int AS views
          FROM analytics_events e
          JOIN analytics_sessions s ON s.id = e.session_id
          WHERE e.website_id = ${websiteId} AND s.is_bot = false
            AND e.created_at >= NOW() - (${interval})::interval
          GROUP BY e.session_id
        )
        SELECT
          COALESCE(SUM(ev.views), 0)::int                      AS pageviews,
          COUNT(DISTINCT sess.id)::int                         AS sessions,
          COUNT(DISTINCT sess.visitor_hash)::int               AS visitors,
          COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE ev.views = 1)
                         / NULLIF(COUNT(*), 0), 1), 0)::float  AS bounce_rate_percent,
          COALESCE(AVG(sess.dur), 0)::int                      AS avg_session_secs,
          COALESCE(ROUND(AVG(ev.views)::numeric, 2), 0)::float AS views_per_session
        FROM sess LEFT JOIN ev ON ev.session_id = sess.id
      `;
  const r = rows[0] as DbRow | undefined;
  return {
    range,
    pageviews: (r?.pageviews as number) ?? 0,
    sessions: (r?.sessions as number) ?? 0,
    visitors: (r?.visitors as number) ?? 0,
    bounce_rate_percent: (r?.bounce_rate_percent as number) ?? 0,
    avg_session_secs: (r?.avg_session_secs as number) ?? 0,
    views_per_session: (r?.views_per_session as number) ?? 0,
  };
}

export interface EntryExitRow {
  path: string;
  title: string | null;
  sessions: number;
}

export async function getEntryPages(
  websiteId: string,
  range: Range,
  companyId?: string | null,
  limit = 15
): Promise<EntryExitRow[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;
  const interval = RANGE_INTERVAL[range];
  // LATERAL pulls a single page_title per session for its entry_path. The
  // outer aggregation picks the title from the EARLIEST session that landed
  // on this entry_path (ordered by session.first_seen) — deterministic and
  // matches the page title users actually saw when the path was first seen
  // in the window. (MAX(page_title) — the original draft of this fix — was
  // lexicographically arbitrary across sessions for the same path.)
  const rows = await sql`
    SELECT s.entry_path AS path,
           (array_agg(e.page_title ORDER BY s.first_seen ASC)
              FILTER (WHERE e.page_title IS NOT NULL))[1] AS title,
           COUNT(*)::int                                          AS sessions
    FROM analytics_sessions s
    LEFT JOIN LATERAL (
      SELECT page_title
      FROM analytics_events
      WHERE session_id = s.id
        AND url_path = s.entry_path
      ORDER BY created_at ASC
      LIMIT 1
    ) e ON true
    WHERE s.website_id = ${websiteId}
      AND s.is_bot = false
      AND s.first_seen >= NOW() - (${interval})::interval
      AND s.entry_path IS NOT NULL
    GROUP BY s.entry_path
    ORDER BY sessions DESC
    LIMIT ${limit}
  `;
  return rows as EntryExitRow[];
}

export async function getExitPages(
  websiteId: string,
  range: Range,
  companyId?: string | null,
  limit = 15
): Promise<EntryExitRow[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;
  const interval = RANGE_INTERVAL[range];
  const rows = await sql`
    WITH last_events AS (
      SELECT DISTINCT ON (e.session_id)
        e.session_id, e.url_path, e.page_title
      FROM analytics_events e
      JOIN analytics_sessions s ON s.id = e.session_id
      WHERE e.website_id = ${websiteId}
        AND s.is_bot = false
        AND e.event_type = 'pageview'
        AND e.created_at >= NOW() - (${interval})::interval
      ORDER BY e.session_id, e.created_at DESC
    )
    SELECT url_path AS path, page_title AS title, COUNT(*)::int AS sessions
    FROM last_events
    GROUP BY url_path, page_title
    ORDER BY sessions DESC
    LIMIT ${limit}
  `;
  return rows as EntryExitRow[];
}

export interface EventRow {
  event_name: string;
  events: number;
  sessions: number;
}

export async function getCustomEvents(
  websiteId: string,
  range: Range,
  companyId?: string | null,
  limit = 20
): Promise<EventRow[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;
  const interval = RANGE_INTERVAL[range];
  const rows = await sql`
    SELECT e.event_name,
           COUNT(*)::int                     AS events,
           COUNT(DISTINCT e.session_id)::int AS sessions
    FROM analytics_events e
    JOIN analytics_sessions s ON s.id = e.session_id
    WHERE e.website_id = ${websiteId}
      AND s.is_bot = false
      AND e.event_type = 'custom'
      AND e.event_name IS NOT NULL
      AND e.created_at >= NOW() - (${interval})::interval
    GROUP BY e.event_name
    ORDER BY events DESC
    LIMIT ${limit}
  `;
  return rows as EventRow[];
}

export interface ChannelRow {
  channel: string;
  sessions: number;
}

export async function getChannels(
  websiteId: string,
  range: Range,
  companyId?: string | null
): Promise<ChannelRow[] | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;
  const interval = RANGE_INTERVAL[range];
  // Classify first-touch source into channels. Priority: utm_medium > known-social
  // referrer > search engine referrer > any referrer > direct.
  const rows = await sql`
    WITH first_events AS (
      SELECT DISTINCT ON (s.id)
        s.id, s.utm_source, s.utm_medium, e.referrer_domain
      FROM analytics_sessions s
      LEFT JOIN analytics_events e ON e.session_id = s.id
      WHERE s.website_id = ${websiteId}
        AND s.is_bot = false
        AND s.first_seen >= NOW() - (${interval})::interval
      ORDER BY s.id, e.created_at ASC
    )
    SELECT
      CASE
        WHEN utm_medium ILIKE ANY (ARRAY['cpc','ppc','paid','paid_social','paidsearch']) THEN 'Paid'
        WHEN utm_medium ILIKE 'email'                                                    THEN 'Email'
        WHEN utm_medium ILIKE 'social' OR utm_source ILIKE ANY (ARRAY['linkedin','facebook','twitter','x','instagram','tiktok','youtube','reddit','pinterest'])
          OR referrer_domain ILIKE ANY (ARRAY['%linkedin.com','%facebook.com','%twitter.com','t.co','%x.com','%instagram.com','%tiktok.com','%youtube.com','%reddit.com','%pinterest.com','lnkd.in'])
                                                                                         THEN 'Social'
        WHEN utm_medium ILIKE 'organic'
          OR referrer_domain ILIKE ANY (ARRAY['%google.%','%bing.com','%duckduckgo.com','%yahoo.%','%ecosia.org','%yandex.%','%baidu.com'])
                                                                                         THEN 'Organic Search'
        WHEN utm_medium ILIKE 'referral' OR referrer_domain IS NOT NULL                  THEN 'Referral'
        ELSE 'Direct'
      END AS channel,
      COUNT(*)::int AS sessions
    FROM first_events
    GROUP BY 1
    ORDER BY sessions DESC
  `;
  return rows as ChannelRow[];
}
