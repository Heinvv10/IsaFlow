/**
 * Admin dashboard "Trials Expiring Soon" card: the companies whose trial ends
 * within 7 days (GET /api/admin/trials?within=7), each with "+7 days" and
 * "Upgrade". The page owns the data, the extend call and when to show it.
 */
import Link from 'next/link';
import { Clock, Loader2 } from 'lucide-react';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { formatDisplayDate } from '@/utils/dateFormat';

export interface TrialRow {
  id: string;
  name: string;
  trial_ends_at: string;
  user_count: number;
  days_left: number;
  status: string;
}

function trialDaysBadge(days: number) {
  if (days <= 0) return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">Expired</span>;
  if (days <= 2) return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/20 text-red-400">{days}d</span>;
  if (days <= 5) return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-500/20 text-orange-400">{days}d</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-400">{days}d</span>;
}

function fmtTrialDate(iso: string): string {
  return formatDisplayDate(iso);
}

export function TrialsExpiringSoon({ trials, extendingId, onExtend }: {
  trials: TrialRow[];
  extendingId: string | null;
  onExtend: (companyId: string) => void;
}) {
  const adminHref = useAdminHref();
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm mb-8">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-yellow-500" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Trials Expiring Soon</h2>
          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-400">{trials.length}</span>
        </div>
        <Link href={adminHref('/admin/trials')} className="text-xs text-teal-500 hover:text-teal-400 font-medium">
          View All Trials
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-faint dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <th className="px-5 py-3 font-medium">Company</th>
              <th className="px-5 py-3 font-medium">Trial Ends</th>
              <th className="px-5 py-3 font-medium">Users</th>
              <th className="px-5 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {trials.map((trial) => (
              <tr key={trial.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                <td className="px-5 py-3 font-medium text-gray-900 dark:text-white">{trial.name}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-ink-faint dark:text-gray-400 whitespace-nowrap">{fmtTrialDate(trial.trial_ends_at)}</span>
                    {trialDaysBadge(trial.days_left)}
                  </div>
                </td>
                <td className="px-5 py-3 text-ink-faint dark:text-gray-400">{trial.user_count}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onExtend(trial.id)}
                      disabled={extendingId === trial.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-teal-600/20 hover:bg-teal-600/40 text-teal-400 rounded-md transition-colors disabled:opacity-40"
                    >
                      {extendingId === trial.id && <Loader2 className="w-3 h-3 animate-spin" />}
                      +7 days
                    </button>
                    <Link
                      href={adminHref(`/admin/companies/${trial.id}`)}
                      className="px-2.5 py-1 text-xs bg-gray-100 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/70 text-gray-700 dark:text-gray-300 rounded-md transition-colors"
                    >
                      Upgrade
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
