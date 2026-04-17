/**
 * Churn Trend Chart — 6-month churn rate % line chart.
 * Dynamically imported with ssr: false from parent.
 */

import dynamic from 'next/dynamic';
import type { ChurnTrendPoint } from '@/modules/admin/types/admin.types';

const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const LineChart           = dynamic(() => import('recharts').then((m) => m.LineChart),           { ssr: false });
const Line                = dynamic(() => import('recharts').then((m) => m.Line),                { ssr: false });
const XAxis               = dynamic(() => import('recharts').then((m) => m.XAxis),               { ssr: false });
const YAxis               = dynamic(() => import('recharts').then((m) => m.YAxis),               { ssr: false });
const CartesianGrid       = dynamic(() => import('recharts').then((m) => m.CartesianGrid),       { ssr: false });
const Tooltip             = dynamic(() => import('recharts').then((m) => m.Tooltip),             { ssr: false });
const ReferenceLine       = dynamic(() => import('recharts').then((m) => m.ReferenceLine),       { ssr: false });

interface Props {
  data: ChurnTrendPoint[];
}

function fmtMonth(dateStr: unknown) {
  const d = new Date(String(dateStr ?? ''));
  return d.toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' });
}

export function ChurnTrendChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-600 dark:text-gray-400 text-sm">
        No churn data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={(v: unknown) => fmtMonth(v)}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v: number) => `${v}%`}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={40}
          domain={[0, 'auto']}
        />
        <ReferenceLine y={5} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.5} />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
          labelStyle={{ color: '#e5e7eb', marginBottom: 4 }}
          labelFormatter={(label: unknown) => fmtMonth(String(label))}
          formatter={(value: unknown, _name: unknown, props: { payload?: { churned_companies?: number } }) => [
            `${Number(value ?? 0)}% (${props?.payload?.churned_companies ?? 0} churned)`,
            'Churn Rate',
          ]}
        />
        <Line
          type="monotone"
          dataKey="churn_rate_pct"
          name="Churn Rate"
          stroke="#ef4444"
          strokeWidth={2}
          dot={{ r: 4, fill: '#ef4444' }}
          activeDot={{ r: 6 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
