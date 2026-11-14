/**
 * Admin Web Analytics page: the shapes the summary/realtime routes answer, the
 * range options and a duration formatter. Split out of pages/admin/web-analytics.tsx
 * (300-line cap); no behaviour change.
 */
import type { TimeseriesPoint } from '@/components/admin/charts/TrafficTimeseriesChart';

export type Range = '24h' | '7d' | '30d' | '90d';

export interface Website {
  id: string;
  name: string;
  tracking_id: string;
  domain: string | null;
  category: 'marketing' | 'app' | 'admin' | 'portal';
  company_id: string | null;
}

export interface Overview {
  range: Range;
  pageviews: number;
  sessions: number;
  visitors: number;
  bounce_rate_percent: number;
  avg_session_secs: number;
  views_per_session: number;
}

export interface Summary {
  overview: Overview;
  timeseries: TimeseriesPoint[];
  top_pages: Array<{ path: string; title: string | null; views: number; sessions: number }>;
  top_referrers: Array<{ domain: string; views: number; sessions: number }>;
  traffic_sources: Array<{ source: string; medium: string | null; campaign: string | null; sessions: number }>;
  channels: Array<{ channel: string; sessions: number }>;
  entry_pages: Array<{ path: string; title: string | null; sessions: number }>;
  exit_pages: Array<{ path: string; title: string | null; sessions: number }>;
  custom_events: Array<{ event_name: string; events: number; sessions: number }>;
  countries: Array<{ label: string; sessions: number }>;
  devices: Array<{ label: string; sessions: number }>;
  browsers: Array<{ label: string; sessions: number }>;
  operating_systems: Array<{ label: string; sessions: number }>;
  languages: Array<{ label: string; sessions: number }>;
}

export type Metric = 'pageviews' | 'sessions' | 'visitors';

export interface Realtime {
  active_users_5m: number;
  pageviews_5m: number;
  top_paths_5m: Array<{ path: string; views: number }>;
}

export const RANGES: Array<{ id: Range; label: string }> = [
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d',  label: 'Last 7 days'   },
  { id: '30d', label: 'Last 30 days'  },
  { id: '90d', label: 'Last 90 days'  },
];

export function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}
