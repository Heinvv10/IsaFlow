/**
 * Bulk-action confirmation modal for the Fiscal Periods page.
 * Renders a tone-appropriate Cancel/Confirm dialog for close, reopen, or lock
 * across N selected periods.
 */
import { Loader2 } from 'lucide-react';

export type BulkAction = 'bulk_close' | 'bulk_reopen' | 'bulk_lock';

interface Props {
  action: BulkAction;
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BulkConfirmModal({ action, count, busy, onCancel, onConfirm }: Props) {
  const verb = action === 'bulk_close' ? 'Close' : action === 'bulk_lock' ? 'Lock' : 'Reopen';
  const tone =
    action === 'bulk_lock'   ? 'bg-red-600 hover:bg-red-700'
    : action === 'bulk_reopen' ? 'bg-emerald-600 hover:bg-emerald-700'
    : 'bg-blue-600 hover:bg-blue-700';
  const explainer =
    action === 'bulk_close'  ? 'Closed periods refuse new postings until reopened.'
    : action === 'bulk_reopen' ? 'Reopening allows new journal entries to post against the selected periods.'
    : 'Locking is final — locked periods cannot be reopened. Use Close if you want the option to reverse.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-slate-950/80 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">{verb} {count} period{count !== 1 ? 's' : ''}?</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{explainer}</p>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2 bg-slate-50/50 dark:bg-slate-800/20">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className={`px-5 py-2 text-sm font-semibold text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2 ${tone}`}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? `${verb}ing…` : verb}
          </button>
        </div>
      </div>
    </div>
  );
}
