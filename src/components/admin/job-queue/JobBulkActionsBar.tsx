/**
 * JobBulkActionsBar — sticky action bar shown when jobs are selected.
 */

import { Loader2, RotateCcw, XCircle, X } from 'lucide-react';

interface Props {
  count: number;
  loading: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onClear: () => void;
}

export function JobBulkActionsBar({ count, loading, onRetry, onCancel, onClear }: Props) {
  return (
    <div className="flex items-center gap-3 flex-wrap px-4 py-2.5 bg-blue-900/20 border border-blue-700/40 rounded-xl mb-4 text-sm">
      <span className="font-medium text-blue-200 mr-1">
        {count} {count === 1 ? 'job' : 'jobs'} selected
      </span>

      <button
        disabled={loading}
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-600/50 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
      >
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <RotateCcw className="w-3.5 h-3.5" />
        }
        Retry Selected
      </button>

      <button
        disabled={loading}
        onClick={onCancel}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-600/50 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
      >
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <XCircle className="w-3.5 h-3.5" />
        }
        Cancel Selected
      </button>

      <button
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        title="Clear selection"
      >
        <X className="w-3.5 h-3.5" />
        Clear
      </button>
    </div>
  );
}
