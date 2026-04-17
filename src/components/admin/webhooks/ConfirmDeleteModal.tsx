/**
 * ConfirmDeleteModal — confirmation dialog before deleting a webhook.
 */

import { Loader2 } from 'lucide-react';

interface Props {
  url: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}

export function ConfirmDeleteModal({ url, onConfirm, onCancel, loading }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
        <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-2">Delete Webhook?</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">This will permanently delete:</p>
        <p className="text-xs font-mono text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 rounded px-3 py-2 mb-4 break-all">
          {url}
        </p>
        <p className="text-sm text-amber-400 mb-5">
          All delivery history will also be deleted. This cannot be undone.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Delete Webhook
          </button>
        </div>
      </div>
    </div>
  );
}
