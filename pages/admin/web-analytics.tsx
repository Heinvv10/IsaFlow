/**
 * Admin Web Analytics — real-time traffic monitor + page analytics dashboard.
 * Switch between registered websites (marketing, app, admin, portals).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { StatsCard } from '@/components/admin/StatsCard';
import { TrafficTimeseriesChart, type TimeseriesPoint } from '@/components/admin/charts/TrafficTimeseriesChart';
import { apiFetch } from '@/lib/apiFetch';
import { Activity, Loader2, Globe } from 'lucide-react';

type Range = '24h' | '7d' | '30d' | '90d';

interface Website {
  id: string;
  name: string;
  tracking_id: string;
  domain: string | null;
  category: 'marketing' | 'app' | 'admin' | 'portal';
  company_id: string | null;
}

interface Overview {
  range: Range;
  pageviews: number;
  sessions: number;
  visitors: number;
  bounce_rate_percent: number;
  avg_session_secs: number;
}

interface Summary {
  overview: Overview;
  timeseries: TimeseriesPoint[];
  top_pages: Array<{ path: string; views: number; sessions: number }>;
  top_referrers: Array<{ domain: string; views: number; sessions: number }>;
  countries: Array<{ label: string; sessions: number }>;
  devices: Array<{ label: string; sessions: number }>;
  browsers: Array<{ label: string; sessions: number }>;
}

interface Realtime {
  active_users_5m: number;
  pageviews_5m: number;
  top_paths_5m: Array<{ path: string; views: number }>;
}

const RANGES: Array<{ id: Range; label: string }> = [
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d',  label: 'Last 7 days'   },
  { id: '30d', label: 'Last 30 days'  },
  { id: '90d', label: 'Last 90 days'  },
];

function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function Panel({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-5 ${className}`}>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Table({ rows, labelCol, valueCol }: {
  rows: Array<{ label: string; value: number }>;
  labelCol: string;
  valueCol: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No data yet</p>;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider pb-1">
        <span>{labelCol}</span><span>{valueCol}</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="relative">
          <div
            className="absolute inset-y-0 left-0 bg-teal-500/10 rounded"
            style={{ width: `${(r.value / max) * 100}%` }}
          />
          <div className="relative flex justify-between items-center py-1.5 px-2 text-sm">
            <span className="truncate mr-2 text-gray-900 dark:text-gray-100">{r.label}</span>
            <span className="font-medium text-gray-700 dark:text-gray-300 tabular-nums">{r.value.toLocaleString('en-ZA')}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminWebAnalytics() {
  const [websites, setWebsites] = useState<Website[]>([]);
  const [websiteId, setWebsiteId] = useState<string>('');
  const [range, setRange] = useState<Range>('7d');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [realtime, setRealtime] = useState<Realtime | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/admin/analytics/web/websites');
        const json = await res.json();
        const ws: Website[] = json?.data?.websites ?? [];
        setWebsites(ws);
        if (ws.length > 0 && !websiteId) setWebsiteId(ws[0]!.id);
      } catch (e) {
        setError('Failed to load websites');
      }
    })();
  }, []);

  const loadSummary = useCallback(async () => {
    if (!websiteId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/analytics/web/summary?website_id=${websiteId}&range=${range}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json?.error?.message || 'Failed to load summary');
        setSummary(null);
      } else {
        setSummary(json.data as Summary);
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [websiteId, range]);

  const loadRealtime = useCallback(async () => {
    if (!websiteId) return;
    try {
      const res = await apiFetch(`/api/admin/analytics/web/realtime?website_id=${websiteId}`);
      const json = await res.json();
      if (res.ok && json.success) setRealtime(json.data as Realtime);
    } catch { /* silent */ }
  }, [websiteId]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => {
    void loadRealtime();
    const iv = setInterval(loadRealtime, 5000);
    return () => clearInterval(iv);
  }, [loadRealtime]);

  const grouped = useMemo(() => {
    const g: Record<string, Website[]> = { marketing: [], app: [], admin: [], portal: [] };
    websites.forEach((w) => { g[w.category]?.push(w); });
    return g;
  }, [websites]);

  return (
    <AdminLayout title="Web Analytics">
      <div className="space-y-6">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex items-center gap-3">
            <Globe className="w-5 h-5 text-gray-500" />
            <select
              value={websiteId}
              onChange={(e) => setWebsiteId(e.target.value)}
              className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-teal-500 focus:outline-none"
            >
              {(['marketing', 'app', 'admin', 'portal'] as const).map((cat) => {
                const group = grouped[cat] || [];
                if (group.length === 0) return null;
                return (
                  <optgroup key={cat} label={cat.charAt(0).toUpperCase() + cat.slice(1)}>
                    {group.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}{w.domain ? ` — ${w.domain}` : ''}</option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>

          <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                className={[
                  'px-3 py-1 text-sm rounded-md transition-colors',
                  range === r.id
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white',
                ].join(' ')}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-gradient-to-br from-teal-500/10 to-transparent border border-teal-500/30 rounded-xl p-5 flex items-center gap-4">
          <div className="relative">
            <Activity className="w-7 h-7 text-teal-500" />
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-teal-500 rounded-full animate-pulse" />
          </div>
          <div className="flex-1">
            <p className="text-xs uppercase tracking-wider text-teal-600 dark:text-teal-400 font-semibold">Live — last 5 minutes</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-white leading-tight">
              {realtime?.active_users_5m ?? 0} active {(realtime?.active_users_5m ?? 0) === 1 ? 'visitor' : 'visitors'}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {realtime?.pageviews_5m ?? 0} pageview{(realtime?.pageviews_5m ?? 0) === 1 ? '' : 's'} · auto-refreshing every 5s
            </p>
          </div>
          {realtime && realtime.top_paths_5m.length > 0 && (
            <div className="hidden md:block text-right">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Top page now</p>
              <p className="text-sm font-mono text-gray-900 dark:text-white truncate max-w-xs">
                {realtime.top_paths_5m[0]?.path ?? '—'}
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-4 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {loading && !summary && (
          <div className="flex items-center justify-center py-16 text-gray-500">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        )}

        {summary && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatsCard title="Pageviews" value={summary.overview.pageviews.toLocaleString('en-ZA')} />
              <StatsCard title="Sessions"  value={summary.overview.sessions.toLocaleString('en-ZA')} />
              <StatsCard title="Visitors"  value={summary.overview.visitors.toLocaleString('en-ZA')} />
              <StatsCard title="Bounce rate" value={`${summary.overview.bounce_rate_percent}%`} />
              <StatsCard title="Avg session" value={fmtDuration(summary.overview.avg_session_secs)} />
            </div>

            <Panel title="Traffic over time">
              <TrafficTimeseriesChart data={summary.timeseries} range={range} />
            </Panel>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Panel title="Top pages">
                <Table
                  rows={summary.top_pages.map((p) => ({ label: p.path, value: p.views }))}
                  labelCol="Path" valueCol="Views"
                />
              </Panel>
              <Panel title="Top referrers">
                <Table
                  rows={summary.top_referrers.map((r) => ({ label: r.domain, value: r.views }))}
                  labelCol="Source" valueCol="Views"
                />
              </Panel>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Panel title="Countries">
                <Table
                  rows={summary.countries.map((c) => ({ label: c.label, value: c.sessions }))}
                  labelCol="Country" valueCol="Sessions"
                />
              </Panel>
              <Panel title="Devices">
                <Table
                  rows={summary.devices.map((d) => ({ label: d.label, value: d.sessions }))}
                  labelCol="Device" valueCol="Sessions"
                />
              </Panel>
              <Panel title="Browsers">
                <Table
                  rows={summary.browsers.map((b) => ({ label: b.label, value: b.sessions }))}
                  labelCol="Browser" valueCol="Sessions"
                />
              </Panel>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
