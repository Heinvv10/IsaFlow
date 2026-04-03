/**
 * BillsToPayWidget — AP summary using /api/accounting/dashboard-stats.
 * // WORKING: Mirror of InvoicesOwedWidget but for payables.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Receipt, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface APStats {
  apTotal: number;
  apOverdue: number;
  apCurrent: number;
}

function fmtCurrency(n: number): string {
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function BillsToPayWidget() {
  const [stats, setStats] = useState<APStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/accounting/dashboard-stats');
        const json = (await res.json()) as { data?: { apTotal: number; apOverdue?: number } };
        const d = json.data ?? { apTotal: 0 };
        setStats({
          apTotal: d.apTotal ?? 0,
          apOverdue: d.apOverdue ?? 0,
          apCurrent: Math.max(0, (d.apTotal ?? 0) - (d.apOverdue ?? 0)),
        });
      } catch (err) {
        log.error('BillsToPayWidget fetch failed', { error: err }, 'dashboard-widget');
        setError('Unable to load AP data');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

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
      ) : stats ? (
        <div className="space-y-4">
          <div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {fmtCurrency(stats.apTotal)}
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
                {fmtCurrency(stats.apCurrent)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5" />
                Overdue
              </div>
              <span className="text-xs font-medium text-red-600 dark:text-red-400">
                {fmtCurrency(stats.apOverdue)}
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
      ) : null}
    </Card>
  );
}
