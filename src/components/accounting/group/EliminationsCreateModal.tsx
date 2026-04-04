/**
 * EliminationsCreateModal
 * Manual elimination journal entry form.
 */

import React from 'react';
import { Loader2, Plus, X, Trash2, AlertCircle } from 'lucide-react';
import {
  fmt,
  selectClass,
  inputClass,
  ELIMINATION_TYPE_LABELS,
  type EliminationType,
  type EliminationLine,
} from './EliminationsShared';

interface Props {
  formType: EliminationType;
  formDescription: string;
  formPeriod: string;
  formLines: EliminationLine[];
  formError: string;
  formSaving: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  onTypeChange: (t: EliminationType) => void;
  onDescriptionChange: (v: string) => void;
  onPeriodChange: (v: string) => void;
  onAddLine: () => void;
  onRemoveLine: (idx: number) => void;
  onUpdateLine: (idx: number, field: keyof EliminationLine, value: string | number) => void;
}

export function EliminationsCreateModal({
  formType, formDescription, formPeriod, formLines, formError, formSaving,
  onClose, onSubmit, onTypeChange, onDescriptionChange, onPeriodChange,
  onAddLine, onRemoveLine, onUpdateLine,
}: Props) {
  const totalDebit = formLines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredit = formLines.reduce((s, l) => s + Number(l.credit || 0), 0);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--ff-surface-primary)] rounded-xl border border-[var(--ff-border-light)] w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ff-border-light)]">
          <h2 className="text-lg font-bold text-[var(--ff-text-primary)]">
            Create Manual Elimination
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={onSubmit} className="p-6 space-y-4">
          {formError && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" /> {formError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Type</label>
              <select
                value={formType}
                onChange={(e) => onTypeChange(e.target.value as EliminationType)}
                className={selectClass + ' w-full'}
              >
                {(Object.keys(ELIMINATION_TYPE_LABELS) as EliminationType[]).map((t) => (
                  <option key={t} value={t}>{ELIMINATION_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Period</label>
              <input
                type="date"
                value={formPeriod}
                onChange={(e) => onPeriodChange(e.target.value)}
                className={inputClass + ' w-full'}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Description</label>
            <input
              type="text"
              value={formDescription}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Describe the elimination adjustment..."
              className={inputClass + ' w-full'}
              required
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-[var(--ff-text-tertiary)]">Journal Lines</label>
              <button
                type="button"
                onClick={onAddLine}
                className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300"
              >
                <Plus className="h-3 w-3" /> Add Line
              </button>
            </div>
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_100px_100px_32px] gap-2 text-xs text-[var(--ff-text-tertiary)]">
                <span>Group Account Code</span>
                <span className="text-right">Debit</span>
                <span className="text-right">Credit</span>
                <span />
              </div>
              {formLines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_100px_100px_32px] gap-2">
                  <input
                    type="text"
                    value={line.groupAccountCode}
                    onChange={(e) => onUpdateLine(idx, 'groupAccountCode', e.target.value)}
                    placeholder="e.g. 4000"
                    className={inputClass + ' w-full'}
                    required
                  />
                  <input
                    type="number" step="0.01" min="0"
                    value={line.debit || ''}
                    onChange={(e) => onUpdateLine(idx, 'debit', parseFloat(e.target.value) || 0)}
                    placeholder="0.00"
                    className={inputClass + ' w-full text-right'}
                  />
                  <input
                    type="number" step="0.01" min="0"
                    value={line.credit || ''}
                    onChange={(e) => onUpdateLine(idx, 'credit', parseFloat(e.target.value) || 0)}
                    placeholder="0.00"
                    className={inputClass + ' w-full text-right'}
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveLine(idx)}
                    disabled={formLines.length <= 2}
                    className="p-1.5 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 disabled:opacity-30"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-[1fr_100px_100px_32px] gap-2 mt-2 pt-2 border-t border-[var(--ff-border-light)] text-xs font-medium text-[var(--ff-text-primary)]">
              <span>Totals</span>
              <span className="text-right font-mono">{fmt(totalDebit)}</span>
              <span className="text-right font-mono">{fmt(totalCredit)}</span>
              <span />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-[var(--ff-border-light)]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={formSaving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50"
            >
              {formSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create Elimination
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
