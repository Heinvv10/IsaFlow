/**
 * BillsToPayWidget — AP summary using shared dashboard stats.
 */

import Link from 'next/link';
import { Receipt, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { useDashboardStats } from '@/hooks/useDashboardStats';

function fmtCurrency(n: number): string {
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function BillsToPayWidget() {
  const { data, loading, error } = useDashboardStats();
  const apTotal = (data?.apTotal as number) ?? 0;
  const apOverdue = (data?.apOverdue as number) ?? 0;
  const apCurrent = Math.max(0, apTotal - apOverdue);

  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Bills to Pay</span>
        </div>
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton variant="heading" />
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {fmtCurrency(apTotal)}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Total payables outstanding</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Current
              </div>
              <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                {fmtCurrency(apCurrent)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5" />
                Overdue
              </div>
              <span className="text-xs font-medium text-red-600 dark:text-red-400">
                {fmtCurrency(apOverdue)}
              </span>
            </div>
          </div>
          <Link
            href="/accounting/supplier-invoices"
            className="flex items-center gap-1 text-xs text-orange-600 hover:text-orange-700 dark:text-orange-400"
          >
            View all bills <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </Card>
  );
}
