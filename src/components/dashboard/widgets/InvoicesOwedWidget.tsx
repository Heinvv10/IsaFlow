/**
 * InvoicesOwedWidget — AR summary using shared dashboard stats.
 */

import Link from 'next/link';
import { FileText, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { useDashboardStats } from '@/hooks/useDashboardStats';

function fmtCurrency(n: number): string {
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function InvoicesOwedWidget() {
  const { data, loading, error } = useDashboardStats();
  const arTotal = (data?.arTotal as number) ?? 0;
  const arOverdue = (data?.arOverdue as number) ?? 0;
  const arCurrent = Math.max(0, arTotal - arOverdue);

  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-teal-500" />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Invoices Owed</span>
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
              {fmtCurrency(arTotal)}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Total awaiting payment</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Current
              </div>
              <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                {fmtCurrency(arCurrent)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5" />
                Overdue
              </div>
              <span className="text-xs font-medium text-red-600 dark:text-red-400">
                {fmtCurrency(arOverdue)}
              </span>
            </div>
          </div>
          <Link
            href="/accounting/customer-invoices"
            className="flex items-center gap-1 text-xs text-teal-600 hover:text-teal-700 dark:text-teal-400"
          >
            View all invoices <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </Card>
  );
}
