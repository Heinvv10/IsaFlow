/**
 * Financial Years — Add New Fiscal Year modal
 */
import { useState, useCallback } from 'react';
import { X, Calendar, Loader2, AlertCircle } from 'lucide-react';

interface Props {
  existingYears: number[];
  onConfirm: (year: number) => Promise<void>;
  onClose: () => void;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function previewPeriods(year: number): string[] {
  return MONTHS.map(m => `${m} ${year}`);
}

export function AddYearModal({ existingYears, onConfirm, onClose }: Props) {
  const nextYear = existingYears.length > 0
    ? Math.max(...existingYears) + 1
    : new Date().getFullYear();

  const [year, setYear] = useState(nextYear);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isDuplicate = existingYears.includes(year);

  const handleSubmit = useCallback(async () => {
    if (isDuplicate) { setError(`Fiscal year ${year} already exists`); return; }
    if (year < 2000 || year > 2100) { setError('Year must be between 2000 and 2100'); return; }
    setSaving(true);
    setError('');
    try {
      await onConfirm(year);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create year');
    } finally {
      setSaving(false);
    }
  }, [year, isDuplicate, onConfirm, onClose]);

  const preview = previewPeriods(year);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] rounded-2xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ff-border-primary)]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-teal-500/10"><Calendar className="h-4 w-4 text-teal-500" /></div>
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Add New Fiscal Year</h2>
          </div>
          <button onClick={onClose} className="text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Year input */}
          <div>
            <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Calendar Year</label>
            <input
              type="number"
              value={year}
              onChange={e => { setYear(Number(e.target.value)); setError(''); }}
              min={2000} max={2100}
              className={`w-full px-3 py-2 rounded-lg border bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/50 transition-colors ${
                isDuplicate ? 'border-red-500/50' : 'border-[var(--ff-border-primary)]'
              }`}
            />
            {isDuplicate && (
              <p className="text-xs text-red-400 mt-1">Fiscal year {year} already exists</p>
            )}
          </div>

          {/* Period preview */}
          <div>
            <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-2">12 monthly periods will be created:</p>
            <div className="grid grid-cols-3 gap-1">
              {preview.map(p => (
                <div key={p} className="px-2 py-1 rounded bg-teal-500/5 border border-teal-500/20 text-xs text-teal-400 text-center">
                  {p}
                </div>
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[var(--ff-border-primary)]">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
            Cancel
          </button>
          <button onClick={() => void handleSubmit()} disabled={saving || isDuplicate}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-medium transition-colors disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Create Year
          </button>
        </div>
      </div>
    </div>
  );
}
