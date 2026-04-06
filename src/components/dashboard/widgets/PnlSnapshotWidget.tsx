/**
 * PnlSnapshotWidget — Current month P&L summary using shared dashboard stats.
 */

import { TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { useDashboardStats } from '@/hooks/useDashboardStats';

function fmtCurrency(n: number): string {
  if (Math.abs(n) >= 1_000_000) return 'R\u00a0' + (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return 'R\u00a0' + (n / 1_000).toFixed(1) + 'K';
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function currentMonthLabel(): string {
  return new Date().toLocaleString('en-ZA', { month: 'long', year: 'numeric' });
}

export function PnlSnapshotWidget() {
  const { data: raw, loading, error } = useDashboardStats();
  const monthRevenue = (raw?.monthRevenue as number) ?? 0;
  const monthExpenses = (raw?.monthExpenses as number) ?? 0;
  const netProfit = monthRevenue - monthExpenses;
  const isProfit = netProfit >= 0;

  return (
    <Card
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-teal-500" />
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">P&amp;L Snapshot</span>
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400">{currentMonthLabel()}</span>
        </div>
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton variant="heading" />
          <Skeleton variant="text" />
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Net Profit</p>
              <p className={`text-2xl font-bold ${isProfit ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {fmtCurrency(netProfit)}
              </p>
            </div>
            <div className={`p-2 rounded-full ${isProfit ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
              {isProfit
                ? <TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />
                : <TrendingDown className="h-5 w-5 text-red-600 dark:text-red-400" />
              }
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 dark:text-gray-400">Revenue</span>
              <span className="text-xs font-semibold text-green-600 dark:text-green-400">
                {fmtCurrency(monthRevenue)}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
              <div className="h-full rounded-full bg-green-500" style={{ width: '100%' }} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 dark:text-gray-400">Expenses</span>
              <span className="text-xs font-semibold text-orange-600 dark:text-orange-400">
                {fmtCurrency(monthExpenses)}
              </span>
            </div>
            {monthRevenue > 0 && (
              <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                <div
                  className="h-full rounded-full bg-orange-400"
                  style={{ width: `${Math.min(100, (monthExpenses / monthRevenue) * 100).toFixed(1)}%` }}
                />
              </div>
            )}
          </div>
          {monthRevenue > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Margin:{' '}
              <span className={`font-medium ${isProfit ? 'text-green-600' : 'text-red-600'}`}>
                {((netProfit / monthRevenue) * 100).toFixed(1)}%
              </span>
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
