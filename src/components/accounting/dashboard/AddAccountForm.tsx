/**
 * AddAccountForm — the "New Account" panel on the Chart of Accounts tab.
 *
 * Extracted so ChartOfAccountsTab stays inside the 300-line cap after the
 * in-page deactivate dialog replaced window.confirm. Pure presentation: every
 * piece of state and the submit itself stay with the tab, which owns the
 * account list this form's parent picker is built from.
 */

import { Plus, Loader2 } from 'lucide-react';
import type { GLAccount, GLAccountType } from '@/modules/accounting/types/gl.types';
import { subtypeOptionsFor } from './accountSubtypeOptions';

export interface AddAccountFormState {
  accountCode: string;
  accountName: string;
  accountType: GLAccountType;
  accountSubtype: string;
  parentAccountId: string;
  description: string;
}

export function AddAccountForm({
  addForm, parentOptions, isSaving, onChange, onCancel, onSubmit,
}: {
  addForm: AddAccountFormState;
  parentOptions: GLAccount[];
  isSaving: boolean;
  onChange: (updater: (f: AddAccountFormState) => AddAccountFormState) => void;
  onCancel: () => void;
  onSubmit: () => Promise<void>;
}) {
  const subtypes = subtypeOptionsFor(addForm.accountType);

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-teal-500/30 p-4 space-y-4">
      <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">New Account</h4>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Code *</label>
          <input type="text" value={addForm.accountCode} onChange={e => onChange(f => ({ ...f, accountCode: e.target.value }))} placeholder="e.g. 1100" className="ff-input w-full text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Name *</label>
          <input type="text" value={addForm.accountName} onChange={e => onChange(f => ({ ...f, accountName: e.target.value }))} placeholder="e.g. Accounts Receivable" className="ff-input w-full text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Type *</label>
          <select value={addForm.accountType} onChange={e => onChange(f => ({ ...f, accountType: e.target.value as GLAccountType, accountSubtype: '' }))} className="ff-select w-full text-sm">
            <option value="asset">Asset</option>
            <option value="liability">Liability</option>
            <option value="equity">Equity</option>
            <option value="revenue">Revenue</option>
            <option value="expense">Expense</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Subtype</label>
          <select value={addForm.accountSubtype} onChange={e => onChange(f => ({ ...f, accountSubtype: e.target.value }))} className="ff-select w-full text-sm">
            <option value="">None</option>
            {subtypes.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Parent Account</label>
          <select value={addForm.parentAccountId} onChange={e => onChange(f => ({ ...f, parentAccountId: e.target.value }))} className="ff-select w-full text-sm">
            <option value="">None (top-level)</option>
            {parentOptions.map(a => <option key={a.id} value={a.id}>{a.accountCode} - {a.accountName}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Description</label>
          <input type="text" value={addForm.description} onChange={e => onChange(f => ({ ...f, description: e.target.value }))} placeholder="Optional description" className="ff-input w-full text-sm" />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--ff-text-tertiary)]">Normal balance: <span className="font-medium">{addForm.accountType === 'asset' || addForm.accountType === 'expense' ? 'Debit' : 'Credit'}</span> (auto-set from type)</p>
        <div className="flex items-center gap-2">
          <button onClick={() => onCancel()} className="px-3 py-2 text-sm font-medium text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">Cancel</button>
          <button onClick={() => { void onSubmit(); }} disabled={isSaving || !addForm.accountCode || !addForm.accountName} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium disabled:opacity-50">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {isSaving ? 'Creating...' : 'Create Account'}
          </button>
        </div>
      </div>
    </div>
  );
}
