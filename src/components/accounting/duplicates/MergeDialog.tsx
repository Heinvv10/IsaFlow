/**
 * Duplicate Merge Confirmation Dialog
 * PRD: WS-6.6
 */

import { useState } from 'react';
import { Merge, Loader2, AlertCircle, X } from 'lucide-react';
import type { DuplicatePair, DuplicateEntity } from '@/modules/accounting/services/duplicateDetectionService';

export interface MergeDialogState {
  pair: DuplicatePair;
  loading: boolean;
}

interface Props {
  state: MergeDialogState;
  onConfirm: (primaryId: string, duplicateId: string) => Promise<void>;
  onClose: () => void;
}

const FIELD_DEFS: { key: string; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'vatNumber', label: 'VAT Number' },
  { key: 'phone', label: 'Phone' },
  { key: 'itemCode', label: 'Item Code' },
  { key: 'registrationNumber', label: 'Reg. Number' },
  { key: 'contactPerson', label: 'Contact' },
  { key: 'address', label: 'Address' },
  { key: 'billingAddress', label: 'Billing Address' },
];

function relevantFields(a: DuplicateEntity, b: DuplicateEntity) {
  return FIELD_DEFS.filter(f => a[f.key] || b[f.key]);
}

export function MergeDialog({ state, onConfirm, onClose }: Props) {
  const { pair } = state;
  const [primaryChoice, setPrimaryChoice] = useState<'left' | 'right'>('left');

  const chosenPrimary = primaryChoice === 'left' ? pair.primary : pair.duplicate;
  const chosenDuplicate = primaryChoice === 'left' ? pair.duplicate : pair.primary;
  const fields = relevantFields(pair.primary, pair.duplicate);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-[var(--ff-bg-primary)] shadow-2xl border border-[var(--ff-border)] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--ff-border)] px-6 py-4">
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Confirm Merge</h2>
          <button onClick={onClose} className="text-[var(--ff-text-muted)] hover:text-[var(--ff-text-primary)] transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Primary choice */}
          <div>
            <p className="text-sm font-medium text-[var(--ff-text-secondary)] mb-3">Choose which record to keep:</p>
            <div className="grid grid-cols-2 gap-3">
              {(['left', 'right'] as const).map(side => {
                const entity = side === 'left' ? pair.primary : pair.duplicate;
                const selected = primaryChoice === side;
                return (
                  <button
                    key={side}
                    onClick={() => setPrimaryChoice(side)}
                    className={`rounded-lg border-2 p-3 text-left transition-all ${selected ? 'border-teal-500 bg-teal-50' : 'border-[var(--ff-border)] hover:border-teal-300'}`}
                  >
                    <p className="text-xs font-semibold uppercase text-[var(--ff-text-muted)] mb-1">
                      {selected ? 'Keep (Primary)' : 'Delete (Duplicate)'}
                    </p>
                    <p className="text-sm font-medium text-[var(--ff-text-primary)]">{entity.name}</p>
                    {entity.email && <p className="text-xs text-[var(--ff-text-secondary)]">{entity.email}</p>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Field comparison */}
          {fields.length > 0 && (
            <div className="rounded-lg border border-[var(--ff-border)] overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-[var(--ff-bg-secondary)]">
                  <tr>
                    <th className="px-3 py-2 text-left text-[var(--ff-text-muted)] font-semibold">Field</th>
                    <th className="px-3 py-2 text-left text-[var(--ff-text-muted)] font-semibold">Primary Value</th>
                    <th className="px-3 py-2 text-left text-[var(--ff-text-muted)] font-semibold">Duplicate Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border)]">
                  {fields.map(({ key, label }) => (
                    <tr key={key} className="hover:bg-[var(--ff-bg-secondary)]">
                      <td className="px-3 py-2 text-[var(--ff-text-secondary)] font-medium">{label}</td>
                      <td className="px-3 py-2 text-[var(--ff-text-primary)]">{String(chosenPrimary[key] ?? '—')}</td>
                      <td className="px-3 py-2 text-[var(--ff-text-muted)] line-through">{String(chosenDuplicate[key] ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Warning */}
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-800">
              All transactions linked to the duplicate will be reassigned to the primary record.
              The duplicate will be permanently deactivated. This action cannot be undone.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-[var(--ff-border)] px-6 py-4">
          <button
            onClick={onClose}
            disabled={state.loading}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--ff-border)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void onConfirm(chosenPrimary.id, chosenDuplicate.id)}
            disabled={state.loading}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Merge className="h-4 w-4" />}
            Merge &amp; Delete Duplicate
          </button>
        </div>
      </div>
    </div>
  );
}
