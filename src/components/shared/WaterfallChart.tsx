/**
 * WaterfallChart — Reusable waterfall chart component using Recharts.
 * Renders profit waterfalls, cash flow waterfalls, and variance waterfalls.
 */

import dynamic from 'next/dynamic';
import type { WaterfallStep } from '@/modules/accounting/services/waterfallDataService';

const BarChart = dynamic(() => import('recharts').then(m => m.BarChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then(m => m.Bar), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });
const Cell = dynamic(() => import('recharts').then(m => m.Cell), { ssr: false });

interface WaterfallChartProps {
  data: WaterfallStep[];
  height?: number;
  formatValue?: (n: number) => string;
}

const COLORS: Record<string, string> = {
  green: '#14b8a6',
  red: '#f43f5e',
  blue: '#3b82f6',
  teal: '#0d9488',
};

const defaultFormat = (n: number) =>
  n >= 1000000 ? `R ${(n / 1000000).toFixed(1)}M`
  : n >= 1000 ? `R ${(n / 1000).toFixed(0)}K`
  : `R ${n.toFixed(0)}`;

export function WaterfallChart({ data, height = 300, formatValue = defaultFormat }: WaterfallChartProps) {
  // Transform waterfall steps into stacked bar data
  // Each bar has an invisible "base" + visible "value"
  const chartData = data.map(step => {
    const base = step.isSubtotal ? 0 : Math.min(step.start, step.end);
    const visible = Math.abs(step.value);
    return {
      label: step.label,
      base,
      visible,
      rawValue: step.value,
      color: step.color,
      isSubtotal: step.isSubtotal,
    };
  });

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: '#888' }}
          angle={-20}
          textAnchor="end"
          height={50}
        />
        <YAxis tick={{ fontSize: 11, fill: '#888' }} tickFormatter={formatValue} />
        <Tooltip
          contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
          formatter={(_, __, props) => {
            const item = props.payload;
            return [formatValue(item.rawValue), item.label];
          }}
          labelStyle={{ color: '#ccc' }}
        />
        {/* Invisible base bar */}
        <Bar dataKey="base" stackId="waterfall" fill="transparent" />
        {/* Visible value bar */}
        <Bar dataKey="visible" stackId="waterfall" radius={[3, 3, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={COLORS[entry.color] || COLORS.teal}
              opacity={entry.isSubtotal ? 1 : 0.85}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
