/**
 * Customer "Activity" tab on the detail page: the customer's invoices, payments and credit notes, newest first.
 * (Not ActivityTab.tsx, which is the notes / calls timeline.) Mounted only while its tab is open.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { AlertCircle, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { formatDisplayDate } from '@/utils/dateFormat';

interface ActivityRow {
  id: string;
  reference: string;
  date: Date | string;
  due_date?: Date | string | null;
  total_amount: number | string;
  status: string;
  type: 'invoice' | 'payment' | 'credit_note';
}

const TYPE_LABELS: Record<ActivityRow['type'], string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit Note',
};

const TYPE_COLORS: Record<ActivityRow['type'], string> = {
  invoice: 'bg-blue-500/20 text-blue-400',
  payment: 'bg-teal-500/20 text-teal-400',
  credit_note: 'bg-orange-500/20 text-orange-400',
};

const TYPE_PATHS: Record<ActivityRow['type'], string> = {
  invoice: '/accounting/customer-invoices',
  payment: '/accounting/customer-payments',
  credit_note: '/accounting/credit-notes',
};

function toDateStr(val: Date | string | null | undefined): string {
  if (!val) return '—';
  if (val instanceof Date) return formatDisplayDate(val);
  return formatDisplayDate(String(val));
}

export function CustomerTransactionsTab({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/customers?id=${customerId}&include=activity`);
        await assertOk(res, 'Could not load activity - try again');
        const json = await res.json() as { data?: ActivityRow[] } | ActivityRow[];
        const data = (json as { data?: ActivityRow[] }).data ?? (json as ActivityRow[]);
        if (!cancelled) setActivity(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) setActivityError(apiErrorMessage(err, 'Could not load activity - try again'));
      } finally {
        if (!cancelled) setActivityLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [customerId]);

  return (
    <div>
      {activityLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600 dark:text-blue-400" />
        </div>
      )}
      {activityError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="h-4 w-4" /> {activityError}
        </div>
      )}
      {!activityLoading && activity.length === 0 && !activityError && (
        <div className="text-center py-12 text-[var(--ff-text-secondary)]">
          No transactions yet
        </div>
      )}
      {!activityLoading && activity.length > 0 && (
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--ff-border-light)]">
                <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Date</th>
                <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Type</th>
                <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Reference</th>
                <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Amount</th>
                <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {activity.map(row => (
                <tr
                  key={`${row.type}-${row.id}`}
                  className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] transition-colors cursor-pointer"
                  onClick={() => { void router.push(`${TYPE_PATHS[row.type]}/${row.id}`); }}
                >
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{toDateStr(row.date)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[row.type]}`}>
                      {TYPE_LABELS[row.type]}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[var(--ff-text-primary)]">{row.reference}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--ff-text-primary)]">
                    {formatCurrency(Number(row.total_amount))}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/20 text-gray-600 dark:text-gray-400">
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
