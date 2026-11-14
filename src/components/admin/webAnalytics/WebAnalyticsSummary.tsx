/**
 * Admin Web Analytics page: the summary panels (stats, traffic chart, sources,
 * pages, events, audience). Split out of pages/admin/web-analytics.tsx (300-line
 * cap); the markup moved as it was, no behaviour change.
 */
import { StatsCard } from '@/components/admin/StatsCard';
import { TrafficTimeseriesChart } from '@/components/admin/charts/TrafficTimeseriesChart';
import { fmtDuration, type Metric, type Range, type Summary } from './types';

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

export function WebAnalyticsSummary({ summary, range, metric, setMetric }: {
  summary: Summary;
  range: Range;
  metric: Metric;
  setMetric: (m: Metric) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <StatsCard title="Pageviews"  value={summary.overview.pageviews.toLocaleString('en-ZA')} />
        <StatsCard title="Sessions"   value={summary.overview.sessions.toLocaleString('en-ZA')} />
        <StatsCard title="Visitors"   value={summary.overview.visitors.toLocaleString('en-ZA')} />
        <StatsCard title="Views/visit" value={summary.overview.views_per_session.toFixed(2)} />
        <StatsCard title="Bounce rate" value={`${summary.overview.bounce_rate_percent}%`} />
        <StatsCard title="Avg session" value={fmtDuration(summary.overview.avg_session_secs)} />
      </div>

      <Panel title="Traffic over time">
        <div className="flex gap-1 mb-3">
          {(['pageviews', 'sessions', 'visitors'] as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={[
                'px-3 py-1 text-xs rounded-md capitalize transition-colors',
                metric === m
                  ? 'bg-teal-500/15 text-teal-600 dark:text-teal-400 font-medium'
                  : 'text-gray-500 hover:text-gray-800 dark:hover:text-white',
              ].join(' ')}
            >
              {m}
            </button>
          ))}
        </div>
        <TrafficTimeseriesChart data={summary.timeseries} range={range} metric={metric} />
      </Panel>

      <Panel title="Traffic sources (first-touch attribution — UTM + referrer)">
        {summary.traffic_sources.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No sessions yet</p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-12 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider pb-1 px-2">
              <span className="col-span-4">Source</span>
              <span className="col-span-3">Medium</span>
              <span className="col-span-3">Campaign</span>
              <span className="col-span-2 text-right">Sessions</span>
            </div>
            {(() => {
              const max = Math.max(...summary.traffic_sources.map((r) => r.sessions), 1);
              return summary.traffic_sources.map((r, i) => (
                <div key={i} className="relative">
                  <div className="absolute inset-y-0 left-0 bg-teal-500/10 rounded" style={{ width: `${(r.sessions / max) * 100}%` }} />
                  <div className="relative grid grid-cols-12 items-center py-1.5 px-2 text-sm">
                    <span className="col-span-4 truncate font-medium text-gray-900 dark:text-gray-100">{r.source}</span>
                    <span className="col-span-3 truncate text-gray-600 dark:text-gray-400">{r.medium ?? '—'}</span>
                    <span className="col-span-3 truncate text-gray-600 dark:text-gray-400">{r.campaign ?? '—'}</span>
                    <span className="col-span-2 text-right font-medium text-gray-700 dark:text-gray-300 tabular-nums">{r.sessions.toLocaleString('en-ZA')}</span>
                  </div>
                </div>
              ));
            })()}
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Channels">
          <Table
            rows={summary.channels.map((c) => ({ label: c.channel, value: c.sessions }))}
            labelCol="Channel" valueCol="Sessions"
          />
        </Panel>
        <Panel title="Top referrers (raw)">
          <Table
            rows={summary.top_referrers.map((r) => ({ label: r.domain, value: r.views }))}
            labelCol="Source" valueCol="Views"
          />
        </Panel>
      </div>

      <Panel title="Top pages">
        <Table
          rows={summary.top_pages.map((p) => ({ label: p.title || p.path, value: p.views }))}
          labelCol="Page" valueCol="Views"
        />
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Entry pages (where visits start)">
          <Table
            rows={summary.entry_pages.map((p) => ({ label: p.title || p.path, value: p.sessions }))}
            labelCol="Page" valueCol="Sessions"
          />
        </Panel>
        <Panel title="Exit pages (where visits end)">
          <Table
            rows={summary.exit_pages.map((p) => ({ label: p.title || p.path, value: p.sessions }))}
            labelCol="Page" valueCol="Sessions"
          />
        </Panel>
      </div>

      <Panel title="Custom events (outbound clicks, downloads, custom tracking)">
        {summary.custom_events.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No custom events captured yet. Fire them with <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">window.isaTrack.event(&apos;name&apos;, &#123;...&#125;)</code> or let the tracker auto-capture outbound links and downloads.</p>
        ) : (
          <Table
            rows={summary.custom_events.map((e) => ({ label: e.event_name, value: e.events }))}
            labelCol="Event" valueCol="Count"
          />
        )}
      </Panel>

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
        <Panel title="Operating systems">
          <Table
            rows={summary.operating_systems.map((o) => ({ label: o.label, value: o.sessions }))}
            labelCol="OS" valueCol="Sessions"
          />
        </Panel>
        <Panel title="Languages">
          <Table
            rows={summary.languages.map((l) => ({ label: l.label, value: l.sessions }))}
            labelCol="Language" valueCol="Sessions"
          />
        </Panel>
      </div>
    </>
  );
}
