import dynamic from 'next/dynamic';

const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const AreaChart          = dynamic(() => import('recharts').then((m) => m.AreaChart),          { ssr: false });
const Area               = dynamic(() => import('recharts').then((m) => m.Area),               { ssr: false });
const XAxis              = dynamic(() => import('recharts').then((m) => m.XAxis),              { ssr: false });
const YAxis              = dynamic(() => import('recharts').then((m) => m.YAxis),              { ssr: false });
const CartesianGrid      = dynamic(() => import('recharts').then((m) => m.CartesianGrid),      { ssr: false });
const Tooltip            = dynamic(() => import('recharts').then((m) => m.Tooltip),            { ssr: false });

export interface TimeseriesPoint {
  bucket: string;
  pageviews: number;
  sessions: number;
  visitors: number;
}

interface Props {
  data: TimeseriesPoint[];
  range: '24h' | '7d' | '30d' | '90d';
}

function fmtLabel(iso: string, range: Props['range']) {
  const d = new Date(iso);
  if (range === '24h') return d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  if (range === '90d') return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

export function TrafficTimeseriesChart({ data, range }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-600 dark:text-gray-400 text-sm">
        No traffic yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="pvGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#14b8a6" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="vsGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#f59e0b" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
        <XAxis
          dataKey="bucket"
          tickFormatter={(v: unknown) => fmtLabel(String(v ?? ''), range)}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          minTickGap={30}
        />
        <YAxis
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={40}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
          labelStyle={{ color: '#e5e7eb', marginBottom: 4 }}
          labelFormatter={(label: unknown) => fmtLabel(String(label ?? ''), range)}
        />
        <Area type="monotone" dataKey="pageviews" stroke="#14b8a6" strokeWidth={2} fill="url(#pvGradient)" dot={false} name="Pageviews" />
        <Area type="monotone" dataKey="visitors"  stroke="#f59e0b" strokeWidth={2} fill="url(#vsGradient)" dot={false} name="Visitors" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
