/**
 * StatsCard — KPI card for the admin dashboard.
 */

import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: { value: number; label: string };
}

export function StatsCard({ title, value, subtitle, trend }: StatsCardProps) {
  const trendPositive = trend && trend.value > 0;
  const trendNegative = trend && trend.value < 0;
  const trendNeutral  = trend && trend.value === 0;

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 flex flex-col gap-2 shadow-sm">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider truncate">
        {title}
      </p>
      <p className="text-3xl font-bold text-gray-900 dark:text-white leading-none">
        {value}
      </p>
      {subtitle && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>
      )}
      {trend && (
        <div className={[
          'flex items-center gap-1 text-xs font-medium mt-auto',
          trendPositive ? 'text-teal-500' : trendNegative ? 'text-red-400' : 'text-gray-400',
        ].join(' ')}>
          {trendPositive && <TrendingUp className="w-3.5 h-3.5" />}
          {trendNegative && <TrendingDown className="w-3.5 h-3.5" />}
          {trendNeutral  && <Minus className="w-3.5 h-3.5" />}
          <span>
            {trendPositive ? '+' : ''}{trend.value}% {trend.label}
          </span>
        </div>
      )}
    </div>
  );
}
