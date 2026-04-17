/**
 * BulkActionsBar — sticky action bar shown when companies are selected.
 */

import { Loader2, ShieldOff, CalendarClock, Download, X } from 'lucide-react';

export interface BulkAction {
  action: 'suspend' | 'extend_trial' | 'export_csv';
}

interface Props {
  count: number;
  loading: boolean;
  onSuspend: () => void;
  onExtendTrial: () => void;
  onExportCsv: () => void;
  onClear: () => void;
}

export function BulkActionsBar({
  count,
  loading,
  onSuspend,
  onExtendTrial,
  onExportCsv,
  onClear,
}: Props) {
  return (
    <div className="flex items-center gap-3 flex-wrap px-4 py-2.5 bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-700 rounded-xl mb-4 text-sm">
      <span className="font-medium text-teal-800 dark:text-teal-200 mr-1">
        {count} {count === 1 ? 'company' : 'companies'} selected
      </span>

      <button
        disabled={loading}
        onClick={onSuspend}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-yellow-300 dark:border-yellow-700 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10 transition-colors disabled:opacity-50"
      >
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <ShieldOff className="w-3.5 h-3.5" />
        }
        Bulk Suspend
      </button>

      <button
        disabled={loading}
        onClick={onExtendTrial}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50"
      >
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <CalendarClock className="w-3.5 h-3.5" />
        }
        Extend Trial 7d
      </button>

      <button
        disabled={loading}
        onClick={onExportCsv}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
      >
        <Download className="w-3.5 h-3.5" />
        Export CSV
      </button>

      <button
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        title="Clear selection"
      >
        <X className="w-3.5 h-3.5" />
        Clear
      </button>
    </div>
  );
}
