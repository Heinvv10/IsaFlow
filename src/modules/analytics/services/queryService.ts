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
        AND s.last_seen >= NOW() - INTERVAL '5 minutes'
    `,
    sql`
      SELECT COUNT(*)::int AS n
      FROM analytics_events
      WHERE website_id = ${websiteId}
        AND created_at >= NOW() - INTERVAL '5 minutes'
    `,
    sql`
      SELECT url_path AS path, COUNT(*)::int AS views
      FROM analytics_events
      WHERE website_id = ${websiteId}
        AND created_at >= NOW() - INTERVAL '5 minutes'
      GROUP BY url_path
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
        date_trunc(${bucket}, created_at) AS bucket,
        session_id
      FROM analytics_events
      WHERE website_id = ${websiteId}
        AND created_at >= NOW() - (${interval})::interval
    ),
    sess_win AS (
      SELECT id, visitor_hash,
             date_trunc(${bucket}, first_seen) AS bucket
      FROM analytics_sessions
      WHERE website_id = ${websiteId}
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
  const rows = await sql`
    SELECT url_path AS path,
           COUNT(*)::int                  AS views,
           COUNT(DISTINCT session_id)::int AS sessions
    FROM analytics_events
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - (${interval})::interval
      AND event_type = 'pageview'
    GROUP BY url_path
    ORDER BY views DESC
    LIMIT ${limit}
  `;
  return rows as TopPageRow[];
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
    SELECT COALESCE(referrer_domain, '(direct)') AS domain,
           COUNT(*)::int                  AS views,
           COUNT(DISTINCT session_id)::int AS sessions
    FROM analytics_events
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - (${interval})::interval
      AND event_type = 'pageview'
    GROUP BY COALESCE(referrer_domain, '(direct)')
    ORDER BY views DESC
    LIMIT ${limit}
  `;
  return rows as TopReferrerRow[];
}

export type BreakdownDimension = 'country' | 'device' | 'browser' | 'os';

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
        WHERE website_id = ${websiteId} AND first_seen >= NOW() - (${interval})::interval
        GROUP BY 1 ORDER BY sessions DESC LIMIT 20
      `
    : dimension === 'device'
    ? await sql`
        SELECT COALESCE(device, 'Unknown') AS label, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE website_id = ${websiteId} AND first_seen >= NOW() - (${interval})::interval
        GROUP BY 1 ORDER BY sessions DESC LIMIT 20
      `
    : dimension === 'browser'
    ? await sql`
        SELECT COALESCE(browser, 'Unknown') AS label, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE website_id = ${websiteId} AND first_seen >= NOW() - (${interval})::interval
        GROUP BY 1 ORDER BY sessions DESC LIMIT 20
      `
    : await sql`
        SELECT COALESCE(os, 'Unknown') AS label, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE website_id = ${websiteId} AND first_seen >= NOW() - (${interval})::interval
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
}

export async function getOverview(
  websiteId: string,
  range: Range,
  companyId?: string | null
): Promise<OverviewStats | null> {
  const w = await requireWebsite(websiteId, companyId);
  if (!w) return null;

  const interval = RANGE_INTERVAL[range];
  const rows = await sql`
    WITH sess AS (
      SELECT id, visitor_hash,
             EXTRACT(EPOCH FROM (last_seen - first_seen))::int AS dur
      FROM analytics_sessions
      WHERE website_id = ${websiteId}
        AND first_seen >= NOW() - (${interval})::interval
    ),
    ev AS (
      SELECT session_id, COUNT(*)::int AS views
      FROM analytics_events
      WHERE website_id = ${websiteId}
        AND created_at >= NOW() - (${interval})::interval
      GROUP BY session_id
    )
    SELECT
      COALESCE(SUM(ev.views), 0)::int                             AS pageviews,
      COUNT(DISTINCT sess.id)::int                                AS sessions,
      COUNT(DISTINCT sess.visitor_hash)::int                      AS visitors,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE ev.views = 1)
                     / NULLIF(COUNT(*), 0), 1), 0)::float         AS bounce_rate_percent,
      COALESCE(AVG(sess.dur), 0)::int                             AS avg_session_secs
    FROM sess
    LEFT JOIN ev ON ev.session_id = sess.id
  `;
  const r = rows[0] as DbRow | undefined;
  return {
    range,
    pageviews: (r?.pageviews as number) ?? 0,
    sessions: (r?.sessions as number) ?? 0,
    visitors: (r?.visitors as number) ?? 0,
    bounce_rate_percent: (r?.bounce_rate_percent as number) ?? 0,
    avg_session_secs: (r?.avg_session_secs as number) ?? 0,
  };
}
