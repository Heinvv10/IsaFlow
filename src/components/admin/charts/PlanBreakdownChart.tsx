/**
 * Plan Breakdown Chart — horizontal bar chart showing MRR contribution per plan+cycle.
 * Dynamically imported with ssr: false from parent.
 */

import dynamic from 'next/dynamic';
import type { PlanBreakdownRow } from '@/modules/admin/types/admin.types';

const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const BarChart            = dynamic(() => import('recharts').then((m) => m.BarChart),            { ssr: false });
const Bar                 = dynamic(() => import('recharts').then((m) => m.Bar),                 { ssr: false });
const XAxis               = dynamic(() => import('recharts').then((m) => m.XAxis),               { ssr: false });
const YAxis               = dynamic(() => import('recharts').then((m) => m.YAxis),               { ssr: false });
const CartesianGrid       = dynamic(() => import('recharts').then((m) => m.CartesianGrid),       { ssr: false });
const Tooltip             = dynamic(() => import('recharts').then((m) => m.Tooltip),             { ssr: false });
const Cell                = dynamic(() => import('recharts').then((m) => m.Cell),                { ssr: false });

interface Props {
  data: PlanBreakdownRow[];
}

const COLORS = ['#14b8a6', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#10b981'];

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    maximumFractionDigits: 0,
  });
}

export function PlanBreakdownChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        No plan data available
      </div>
    );
  }

  const chartData = data.map((row) => ({
    name: `${row.plan_name} (${row.billing_cycle === 'annual' ? 'Annual' : 'Monthly'})`,
    mrr_cents: row.mrr_cents,
    pct: row.pct_of_total,
    companies: row.company_count,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart
        layout="vertical"
        data={chartData}
        margin={{ top: 4, right: 48, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(v: number) => fmtZAR(v)}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fill: '#d1d5db', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={140}
        />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
          labelStyle={{ color: '#e5e7eb', marginBottom: 4 }}
          formatter={(value: unknown, _name: unknown, props: { payload?: { pct?: number; companies?: number } }) => [
            `${fmtZAR(Number(value ?? 0))} (${props?.payload?.pct ?? 0}% — ${props?.payload?.companies ?? 0} co.)`,
            'MRR',
          ]}
        />
        <Bar dataKey="mrr_cents" radius={[0, 4, 4, 0]}>
          {chartData.map((_entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
