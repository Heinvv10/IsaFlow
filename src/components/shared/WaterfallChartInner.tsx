import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

interface Props {
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
  n >= 1_000_000 ? `R ${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `R ${(n / 1_000).toFixed(0)}K`
  : `R ${n.toFixed(0)}`;

export default function WaterfallChartInner({ data, height = 300, formatValue = defaultFormat }: Props) {
  const chartData = data.map(step => ({
    label: step.label,
    base: step.isSubtotal ? 0 : Math.min(step.start, step.end),
    visible: Math.abs(step.value),
    rawValue: step.value,
    color: step.color,
    isSubtotal: step.isSubtotal,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#888' }} angle={-20} textAnchor="end" height={50} />
        <YAxis tick={{ fontSize: 11, fill: '#888' }} tickFormatter={formatValue} />
        <Tooltip
          contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
          formatter={(_, __, props) => {
            const item = props.payload as { rawValue: number; label: string };
            return [formatValue(item.rawValue), item.label];
          }}
          labelStyle={{ color: '#ccc' }}
        />
        <Bar dataKey="base" stackId="waterfall" fill="transparent" />
        <Bar dataKey="visible" stackId="waterfall" radius={[3, 3, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[entry.color] ?? COLORS.teal} opacity={entry.isSubtotal ? 1 : 0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
