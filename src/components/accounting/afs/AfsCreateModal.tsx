/**
 * Modal form for creating a new AFS document. Extracted from
 * pages/accounting/afs/index.tsx so the page is pure composition and
 * stays under the 300-line file budget.
 */

import { useEffect, useId, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';

export type ReportingFramework = 'ifrs_smes' | 'full_ifrs';

export interface AfsCreateValues {
  fiscalYear: number;
  reportingFramework: ReportingFramework;
}

interface AfsCreateModalProps {
  open: boolean;
  initialYear: number;
  isCreating: boolean;
  /** Caller resolves to an error message string on validation/server failure, or null on success. */
  onSubmit: (values: AfsCreateValues) => Promise<string | null>;
  onClose: () => void;
}

export function AfsCreateModal({
  open,
  initialYear,
  isCreating,
  onSubmit,
  onClose,
}: AfsCreateModalProps) {
  const titleId = useId();
  const [year, setYear] = useState<string>(String(initialYear));
  const [framework, setFramework] = useState<ReportingFramework>('ifrs_smes');
  const [error, setError] = useState<string>('');

  // Re-seed state every time the dialog (re-)opens so callers can pass a
  // fresh suggested year without holding stale form state from a prior open.
  useEffect(() => {
    if (open) {
      setYear(String(initialYear));
      setFramework('ifrs_smes');
      setError('');
    }
  }, [open, initialYear]);

  // Escape closes the modal — disabled while creating so a stray Esc keypress
  // can't swallow user state mid-flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCreating) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isCreating, onClose]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const yearNum = Number(year);
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      setError('Fiscal year must be a 4-digit year between 2000 and 2100.');
      return;
    }
    const errMsg = await onSubmit({ fiscalYear: yearNum, reportingFramework: framework });
    if (errMsg) setError(errMsg);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => { if (!isCreating) onClose(); }}
    >
      <form
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 shadow-xl border border-zinc-200 dark:border-slate-700"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 dark:border-slate-800 px-5 py-3">
          <h2 id={titleId} className="text-base font-semibold text-zinc-900 dark:text-white">New AFS document</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            aria-label="Close"
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-slate-800 text-zinc-500 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <label className="block text-sm">
            <span className="text-zinc-700 dark:text-slate-200 font-medium">Fiscal year</span>
            <input
              type="number"
              min={2000}
              max={2100}
              step={1}
              required
              value={year}
              onChange={e => setYear(e.target.value)}
              className="mt-1 block w-full rounded-md border border-zinc-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
              autoFocus
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-700 dark:text-slate-200 font-medium">Reporting framework</span>
            <select
              value={framework}
              onChange={e => setFramework(e.target.value as ReportingFramework)}
              className="mt-1 block w-full rounded-md border border-zinc-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
            >
              <option value="ifrs_smes">IFRS for SMEs</option>
              <option value="full_ifrs">Full IFRS</option>
            </select>
          </label>
          {error && (
            <div role="alert" className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 dark:border-slate-800 px-5 py-3 bg-zinc-50 dark:bg-slate-950 rounded-b-xl">
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="px-3 py-1.5 rounded-md text-sm text-zinc-700 dark:text-slate-200 hover:bg-zinc-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isCreating}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
