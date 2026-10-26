import { CheckCircle, AlertCircle, Clock } from 'lucide-react';
import type { EmailLogStats } from '../../../../pages/api/admin/email-log';

export function StatsCards({ stats }: { stats: EmailLogStats }) {
  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-teal-500/10">
          <CheckCircle className="h-5 w-5 text-teal-400" />
        </div>
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-400">Total Sent (30d)</p>
          <p className="text-xl font-semibold text-slate-900 dark:text-white">{stats.total_sent.toLocaleString()}</p>
        </div>
      </div>
      <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-red-500/10">
          <AlertCircle className="h-5 w-5 text-red-400" />
        </div>
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-400">Failed (30d)</p>
          <p className="text-xl font-semibold text-slate-900 dark:text-white">{stats.total_failed.toLocaleString()}</p>
        </div>
      </div>
      <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-blue-500/10">
          <Clock className="h-5 w-5 text-blue-400" />
        </div>
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-400">Success Rate</p>
          <p className="text-xl font-semibold text-slate-900 dark:text-white">{stats.success_rate}%</p>
        </div>
      </div>
    </div>
  );
}
