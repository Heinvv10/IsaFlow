/**
 * AI Cash Flow Forecast — Chart & sub-components
 * Extracted to keep the page under 300 lines.
 */

import dynamic from 'next/dynamic';

// Dynamic Recharts imports — no SSR
const ResponsiveContainer = dynamic(
  () => import('recharts').then(m => ({ default: m.ResponsiveContainer })),
  { ssr: false },
);
const AreaChart = dynamic(
  () => import('recharts').then(m => ({ default: m.AreaChart })),
  { ssr: false },
);
const Area = dynamic(
  () => import('recharts').then(m => ({ default: m.Area })),
  { ssr: false },
);
const XAxis = dynamic(
  () => import('recharts').then(m => ({ default: m.XAxis })),
  { ssr: false },
);
const YAxis = dynamic(
  () => import('recharts').then(m => ({ default: m.YAxis })),
  { ssr: false },
);
const CartesianGrid = dynamic(
  () => import('recharts').then(m => ({ default: m.CartesianGrid })),
  { ssr: false },
);
const Tooltip = dynamic(
  () => import('recharts').then(m => ({ default: m.Tooltip })),
  { ssr: false },
);
const Legend = dynamic(
  () => import('recharts').then(m => ({ default: m.Legend })),
  { ssr: false },
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CashFlowPeriod {
  weekStart: string;
  inflows: number;
  outflows: number;
  netFlow: number;
  runningBalance: number;
}

export interface ForecastWeek {
  weekStart: string;
  projectedInflows: number;
  projectedOutflows: number;
  projectedNet: number;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export interface CashFlowForecast {
  companyId: string;
  generatedAt: string;
  horizonDays: number;
  historicalPeriods: CashFlowPeriod[];
  forecastPeriods: ForecastWeek[];
  summary: string;
  risks: string[];
  opportunities: string[];
  currentCashBalance: number;
  projectedEndBalance: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fmtCurrency(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (n < 0 ? '-' : '') + 'R ' + abs;
}

export function fmtShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

type ChartPoint = {
  label: string;
  actualBalance: number | null;
  forecastBalance: number | null;
};

export function buildChartData(forecast: CashFlowForecast): ChartPoint[] {
  const points: ChartPoint[] = [];

  for (const h of forecast.historicalPeriods) {
    points.push({ label: fmtShortDate(h.weekStart), actualBalance: h.runningBalance, forecastBalance: null });
  }

  const lastHistorical = forecast.historicalPeriods[forecast.historicalPeriods.length - 1];
  const bridgeBalance = lastHistorical?.runningBalance ?? forecast.currentCashBalance;

  if (forecast.forecastPeriods.length > 0) {
    points.push({ label: 'Now', actualBalance: bridgeBalance, forecastBalance: bridgeBalance });
  }

  let runningForecast = bridgeBalance;
  for (const w of forecast.forecastPeriods) {
    runningForecast += w.projectedNet;
    points.push({ label: fmtShortDate(w.weekStart), actualBalance: null, forecastBalance: runningForecast });
  }

  return points;
}

// ── Sub-components ────────────────────────────────────────────────────────────

export function KpiCard({
  label, value, sub, accent,
}: {
  label: string; value: string; sub?: string; accent: 'teal' | 'rose' | 'amber' | 'blue';
}) {
  const styles: Record<string, string> = {
    teal: 'border-teal-500/30 bg-teal-500/5 text-teal-400',
    rose: 'border-rose-500/30 bg-rose-500/5 text-rose-400',
    amber: 'border-amber-500/30 bg-amber-500/5 text-amber-400',
    blue: 'border-blue-500/30 bg-blue-500/5 text-blue-400',
  };
  return (
    <div className={`rounded-xl border p-4 ${styles[accent]}`}>
      <p className="text-xs font-medium text-[var(--ff-text-secondary)] uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
      {sub && <p className="text-xs text-[var(--ff-text-secondary)] mt-1">{sub}</p>}
    </div>
  );
}

export function ConfidencePip({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const styles = {
    high: 'bg-teal-500/20 text-teal-400 border-teal-500/30',
    medium: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    low: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${styles[confidence]}`}>
      {confidence}
    </span>
  );
}

// ── Chart Component ───────────────────────────────────────────────────────────

interface CashFlowChartProps {
  data: ChartPoint[];
}

export function CashFlowForecastChart({ data }: CashFlowChartProps) {
  return (
    <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
      <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-1">
        Cash Balance — Historical vs Forecast
      </h2>
      <p className="text-xs text-[var(--ff-text-secondary)] mb-4">
        Solid line: actual weekly bank balances. Dashed line: AI-projected forecast.
      </p>
      <div className="h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="gradActual" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#14b8a6" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradForecast" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#2dd4bf" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#2dd4bf" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--ff-border-primary)" />
            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--ff-text-secondary)', fontSize: 11 }}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: 'var(--ff-text-secondary)', fontSize: 11 }}
              tickFormatter={(v: number) => `R${Math.round(v / 1000)}k`}
              width={60}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--ff-surface-primary)',
                border: '1px solid var(--ff-border-primary)',
                borderRadius: '8px',
                color: 'var(--ff-text-primary)',
                fontSize: '12px',
              }}
              formatter={(value: unknown) => [fmtCurrency(Number(value)), '']}
            />
            <Legend wrapperStyle={{ fontSize: '12px', color: 'var(--ff-text-secondary)' }} />
            <Area
              type="monotone"
              dataKey="actualBalance"
              name="Actual Balance"
              stroke="#14b8a6"
              strokeWidth={2}
              fill="url(#gradActual)"
              connectNulls={false}
              dot={false}
            />
            <Area
              type="monotone"
              dataKey="forecastBalance"
              name="Forecast Balance"
              stroke="#2dd4bf"
              strokeWidth={2}
              strokeDasharray="6 3"
              fill="url(#gradForecast)"
              connectNulls={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
