/**
 * Financial Years — Close Year confirmation modal
 * Warns that closing a year locks all open periods (irreversible without admin unlock).
 */
import { AlertTriangle, Lock, Loader2, X } from 'lucide-react';

interface Props {
  year: number;
  openCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
}

export function CloseYearModal({ year, openCount, onConfirm, onCancel, saving }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] rounded-2xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-red-500/20">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-red-500/10"><AlertTriangle className="h-4 w-4 text-red-500" /></div>
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Close Fiscal Year {year}?</h2>
          </div>
          <button onClick={onCancel} className="text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400 space-y-2">
            <p className="font-medium flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 shrink-0" /> This action cannot be easily undone
            </p>
            <ul className="list-disc list-inside space-y-1 text-xs ml-1">
              <li>All {openCount} open period{openCount !== 1 ? 's' : ''} will be closed immediately</li>
              <li>Closed periods cannot accept new journal entries</li>
              <li>Reopening individual periods requires admin privileges</li>
              <li>Year-end closing entries should be posted before closing</li>
            </ul>
          </div>

          <p className="text-sm text-[var(--ff-text-secondary)]">
            Are you sure you want to close <strong className="text-[var(--ff-text-primary)]">FY {year}</strong>?
            This will close all open periods and prevent further postings.
          </p>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[var(--ff-border-primary)]">
          <button onClick={onCancel} disabled={saving}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            Close Year
          </button>
        </div>
      </div>
    </div>
  );
}
