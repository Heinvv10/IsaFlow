/**
 * RecentActivityWidget — Last 5 journal entries from /api/accounting/dashboard-stats.
 * // WORKING: Uses recentJournals from dashboard-stats, no extra endpoint needed.
 */

import { useEffect, useState } from 'react';
import { Clock, FileSpreadsheet } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { formatDisplayDateShort } from '@/utils/dateFormat';

interface JournalEntry {
  id: string;
  date: string | Date;
  description: string;
  source: string;
  status: string;
  amount: number;
}


function fmtCurrency(n: number): string {
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'default'> = {
  posted: 'success',
  draft: 'warning',
};

export function RecentActivityWidget() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/accounting/dashboard-stats');
        const json = (await res.json()) as { data?: { recentJournals?: JournalEntry[] } };
        const d = json.data ?? {};
        setEntries(d.recentJournals ?? []);
      } catch (err) {
        log.error('RecentActivityWidget fetch failed', { error: err }, 'dashboard-widget');
        setError('Unable to load recent activity');
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
          <Clock className="h-4 w-4 text-teal-500" />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Recent Activity</span>
        </div>
      }
      noPadding
    >
      {loading ? (
        <div className="p-4 space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} variant="table-row" />)}
        </div>
      ) : error ? (
        <p className="p-4 text-sm text-red-500">{error}</p>
      ) : entries.length === 0 ? (
        <p className="p-4 text-sm text-gray-500 dark:text-gray-400">No recent journal entries.</p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {entries.map(entry => (
            <div key={entry.id} className="px-4 py-3 flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0 p-1.5 rounded-md bg-gray-100 dark:bg-gray-800">
                <FileSpreadsheet className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">
                  {entry.description || entry.source || 'Journal Entry'}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{formatDisplayDateShort(entry.date)}</span>
                  <Badge variant={STATUS_VARIANT[entry.status] ?? 'default'} size="sm">
                    {entry.status}
                  </Badge>
                </div>
              </div>
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300 flex-shrink-0">
                {fmtCurrency(entry.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
