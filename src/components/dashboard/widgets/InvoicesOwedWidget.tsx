/**
 * InvoicesOwedWidget — AR summary using /api/accounting/dashboard-stats.
 * // WORKING: Color-coded current vs overdue, skeleton loading.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface ARStats {
  arTotal: number;
  arOverdue: number;
  arCurrent: number;
}

function fmtCurrency(n: number): string {
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function InvoicesOwedWidget() {
  const [stats, setStats] = useState<ARStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/accounting/dashboard-stats');
        const json = (await res.json()) as { data?: { arTotal: number; arOverdue?: number } };
        const d = json.data ?? { arTotal: 0 };
        setStats({
          arTotal: d.arTotal ?? 0,
          arOverdue: d.arOverdue ?? 0,
          arCurrent: Math.max(0, (d.arTotal ?? 0) - (d.arOverdue ?? 0)),
        });
      } catch (err) {
        log.error('InvoicesOwedWidget fetch failed', { error: err }, 'dashboard-widget');
        setError('Unable to load AR data');
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
      ) : stats ? (
        <div className="space-y-4">
          <div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {fmtCurrency(stats.arTotal)}
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
                {fmtCurrency(stats.arCurrent)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5" />
                Overdue
              </div>
              <span className="text-xs font-medium text-red-600 dark:text-red-400">
                {fmtCurrency(stats.arOverdue)}
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
      ) : null}
    </Card>
  );
}
