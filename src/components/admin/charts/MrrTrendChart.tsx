/**
 * MRR Trend Chart — 30-day daily MRR area chart (teal, dark-theme friendly)
 */

import dynamic from 'next/dynamic';
import type { MrrTrendPoint } from '@/modules/admin/types/admin.types';

const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const AreaChart          = dynamic(() => import('recharts').then((m) => m.AreaChart),          { ssr: false });
const Area               = dynamic(() => import('recharts').then((m) => m.Area),               { ssr: false });
const XAxis              = dynamic(() => import('recharts').then((m) => m.XAxis),              { ssr: false });
const YAxis              = dynamic(() => import('recharts').then((m) => m.YAxis),              { ssr: false });
const CartesianGrid      = dynamic(() => import('recharts').then((m) => m.CartesianGrid),      { ssr: false });
const Tooltip            = dynamic(() => import('recharts').then((m) => m.Tooltip),            { ssr: false });

interface Props {
  data: MrrTrendPoint[];
}

function fmtShortDate(dateStr: unknown) {
  const d = new Date(String(dateStr ?? ''));
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
}

export function MrrTrendChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-600 dark:text-gray-400 text-sm">
        No MRR data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="mrrGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#14b8a6" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#14b8a6" stopOpacity={0}   />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(v: unknown) => fmtShortDate(v)}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          interval={4}
        />
        <YAxis
          tickFormatter={(v: number) => fmtZAR(v)}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={72}
        />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
          labelStyle={{ color: '#e5e7eb', marginBottom: 4 }}
          labelFormatter={(label) => fmtShortDate(label)}
          formatter={(value: unknown) => [fmtZAR(Number(value ?? 0)), 'MRR']}
        />
        <Area
          type="monotone"
          dataKey="mrr_cents"
          stroke="#14b8a6"
          strokeWidth={2}
          fill="url(#mrrGradient)"
          dot={false}
          activeDot={{ r: 4, fill: '#14b8a6' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
