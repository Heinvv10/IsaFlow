/**
 * Bulk action buttons for time entry selection.
 */

import { Send, CheckCircle, Loader2 } from 'lucide-react';

interface Props {
  count: number;
  busy: string;
  onSubmit: () => void;
  onApprove: () => void;
}

export function BulkActionsBar({ count, busy, onSubmit, onApprove }: Props) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
      <span className="text-sm font-medium text-blue-700 dark:text-blue-300">{count} selected</span>
      <button onClick={onSubmit} disabled={busy === 'submit'}
        className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
        {busy === 'submit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Submit
      </button>
      <button onClick={onApprove} disabled={busy === 'approve'}
        className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
        {busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} Approve
      </button>
    </div>
  );
}
