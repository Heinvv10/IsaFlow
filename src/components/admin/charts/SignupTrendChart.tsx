/**
 * Signup Trend Chart — 30-day new companies and users bar chart
 */

import dynamic from 'next/dynamic';
import type { SignupTrendPoint } from '@/modules/admin/types/admin.types';

const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const BarChart            = dynamic(() => import('recharts').then((m) => m.BarChart),            { ssr: false });
const Bar                 = dynamic(() => import('recharts').then((m) => m.Bar),                 { ssr: false });
const XAxis               = dynamic(() => import('recharts').then((m) => m.XAxis),              { ssr: false });
const YAxis               = dynamic(() => import('recharts').then((m) => m.YAxis),              { ssr: false });
const CartesianGrid       = dynamic(() => import('recharts').then((m) => m.CartesianGrid),      { ssr: false });
const Tooltip             = dynamic(() => import('recharts').then((m) => m.Tooltip),            { ssr: false });
const Legend              = dynamic(() => import('recharts').then((m) => m.Legend),             { ssr: false });

interface Props {
  data: SignupTrendPoint[];
}

function fmtShortDate(dateStr: unknown) {
  const d = new Date(String(dateStr ?? ''));
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

export function SignupTrendChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        No signup data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barCategoryGap="30%">
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
          allowDecimals={false}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={28}
        />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
          labelStyle={{ color: '#e5e7eb', marginBottom: 4 }}
          labelFormatter={(label: unknown) => fmtShortDate(label)}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: '#9ca3af', paddingTop: 8 }}
        />
        <Bar dataKey="new_companies" name="Companies" fill="#7c3aed" radius={[3, 3, 0, 0]} />
        <Bar dataKey="new_users"     name="Users"     fill="#6b7280" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
