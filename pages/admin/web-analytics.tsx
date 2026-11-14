/**
 * Admin Web Analytics — real-time traffic monitor + page analytics dashboard.
 * Switch between registered websites (marketing, app, admin, portals).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { adminExportHref } from '@/components/admin/adminExportHref';
import { downloadAdminExport } from '@/components/admin/downloadAdminExport';
import { RANGES, type Metric, type Range, type Realtime, type Summary, type Website } from '@/components/admin/webAnalytics/types';
import { WebAnalyticsSummary } from '@/components/admin/webAnalytics/WebAnalyticsSummary';
import { apiFetch, assertOk, apiErrorMessage, ApiEnvelopeError } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Activity, Loader2, Globe, Download, Bot } from 'lucide-react';

export default function AdminWebAnalytics() {
  const [websites, setWebsites] = useState<Website[]>([]);
  const [websiteId, setWebsiteId] = useState<string>('');
  const [range, setRange] = useState<Range>('7d');
  const [metric, setMetric] = useState<Metric>('pageviews');
  const [includeBots, setIncludeBots] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [realtime, setRealtime] = useState<Realtime | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch('/api/admin/analytics/web/websites');
        await assertOk(res, 'Could not load websites - try again');
        const ws: Website[] = (await res.json())?.data?.websites ?? [];
        setWebsites(ws);
        // No websites (or a failed load, below) means loadSummary's
        // `if (!websiteId) return` guard never fires — clear `loading`
        // here or the initial spinner runs forever.
        if (ws.length > 0) setWebsiteId(prev => prev || ws[0]!.id);
        else setLoading(false);
      } catch (err) {
        setWebsites([]); setError(apiErrorMessage(err, 'Could not load websites - try again'));
        setLoading(false);
      }
    })();
  }, []);

  const loadSummary = useCallback(async () => {
    if (!websiteId) return;
    setLoading(true);
    setError(null);
    try {
      const bots = includeBots ? '&include_bots=1' : '';
      const res = await apiFetch(`/api/admin/analytics/web/summary?website_id=${websiteId}&range=${range}${bots}`);
      await assertOk(res, 'Could not load the analytics summary - try again');
      const json = await res.json();
      if (!json.success) throw new ApiEnvelopeError('Could not load the analytics summary - try again');
      setSummary(json.data as Summary);
    } catch (err) {
      setSummary(null);
      setError(apiErrorMessage(err, 'Could not load the analytics summary - try again'));
    } finally {
      setLoading(false);
    }
  }, [websiteId, range, includeBots]);

  const downloadCsv = useCallback(async () => {
    if (!websiteId) return;
    setExporting(true);
    setError(null);
    try {
      const href = adminExportHref('/api/admin/analytics/web/export', { website_id: websiteId, range, include_bots: includeBots && '1' });
      await downloadAdminExport(href, 'analytics.csv');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not export the CSV - try again'));
    } finally {
      setExporting(false);
    }
  }, [websiteId, range, includeBots]);

  const loadRealtime = useCallback(async () => {
    if (!websiteId) return;
    try {
      const res = await apiFetch(`/api/admin/analytics/web/realtime?website_id=${websiteId}`);
      await assertOk(res, 'Could not refresh the live visitor count'); // polled every 5s: a failed tick keeps the last reading
      const json = await res.json(); if (json.success) setRealtime(json.data as Realtime);
    } catch (err) { log.warn('web-analytics: realtime tick failed, keeping the last reading', { err }); }
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

          <div className="flex gap-2 items-center">
            <button
              onClick={() => setIncludeBots((v) => !v)}
              className={[
                'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors',
                includeBots
                  ? 'bg-orange-500/10 border-orange-500/40 text-orange-600 dark:text-orange-400'
                  : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
              ].join(' ')}
              title="Toggle crawler/bot traffic"
            >
              <Bot className="w-3.5 h-3.5" />
              {includeBots ? 'Bots included' : 'Bots excluded'}
            </button>
            {/* Fetched, not a plain link: the page cannot know the row count, so a refusal (too many events)
                must come back as a message here, not be saved as the file or replace the page. */}
            <button
              onClick={() => void downloadCsv()}
              disabled={!websiteId || exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
              title="Download raw events as CSV"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </button>
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

        {summary && <WebAnalyticsSummary summary={summary} range={range} metric={metric} setMetric={setMetric} />}
      </div>
    </AdminLayout>
  );
}
