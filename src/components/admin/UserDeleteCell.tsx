/** Inline delete cell with confirm/cancel for the admin user list table. */
import { Loader2, Trash2 } from 'lucide-react';

interface Props {
  confirming: boolean;
  working: boolean;
  onRequest: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UserDeleteCell({ confirming, working, onRequest, onConfirm, onCancel }: Props) {
  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <button
          onClick={onConfirm}
          disabled={working}
          className="px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-40 transition-colors"
        >
          {working ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
        </button>
        <button
          onClick={onCancel}
          className="px-2 py-1 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded transition-colors"
        >
          No
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={onRequest}
      className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
      title="Delete user"
    >
      <Trash2 className="w-4 h-4" />
    </button>
  );
}
