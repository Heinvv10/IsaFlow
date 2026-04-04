/**
 * IntercompanyCreateModal
 * Modal form for recording a new intercompany transaction.
 */

import { Loader2, Plus, X } from 'lucide-react';
import { FieldInput, FieldSelect, TX_TYPES } from './IntercompanyShared';

export interface CreateForm {
  sourceCompanyId: string;
  targetCompanyId: string;
  type: string;
  amount: string;
  currency: string;
  date: string;
  description: string;
  journalEntryId: string;
}

interface Props {
  form: CreateForm;
  companies: { id: string; name: string }[];
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onFormChange: (patch: Partial<CreateForm>) => void;
}

export function IntercompanyCreateModal({
  form, companies, saving, onClose, onSubmit, onFormChange,
}: Props) {
  const targetCompanies = companies.filter((c) => c.id !== form.sourceCompanyId);
  const canSubmit = !saving && !!form.sourceCompanyId && !!form.targetCompanyId && !!form.amount;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl w-full max-w-lg mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ff-border-light)]">
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
            Record Intercompany Transaction
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FieldSelect
              label="Source Company"
              value={form.sourceCompanyId}
              onChange={(v) => onFormChange({ sourceCompanyId: v })}
              options={companies.map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Select..."
            />
            <FieldSelect
              label="Target Company"
              value={form.targetCompanyId}
              onChange={(v) => onFormChange({ targetCompanyId: v })}
              options={targetCompanies.map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Select..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FieldSelect
              label="Transaction Type"
              value={form.type}
              onChange={(v) => onFormChange({ type: v })}
              options={TX_TYPES.map((t) => ({ value: t.value, label: t.label }))}
            />
            <FieldInput
              label="Currency"
              value={form.currency}
              onChange={(v) => onFormChange({ currency: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FieldInput
              label="Amount"
              type="number"
              value={form.amount}
              onChange={(v) => onFormChange({ amount: v })}
              placeholder="0.00"
            />
            <FieldInput
              label="Date"
              type="date"
              value={form.date}
              onChange={(v) => onFormChange({ date: v })}
            />
          </div>

          <FieldInput
            label="Description"
            value={form.description}
            onChange={(v) => onFormChange({ description: v })}
            placeholder="e.g. Management fee Q1 2026"
          />

          <FieldInput
            label="Journal Entry ID (optional)"
            value={form.journalEntryId}
            onChange={(v) => onFormChange({ journalEntryId: v })}
            placeholder="Leave blank if not linked"
          />
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--ff-border-light)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-40 transition-colors"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Record
          </button>
        </div>
      </div>
    </div>
  );
}
