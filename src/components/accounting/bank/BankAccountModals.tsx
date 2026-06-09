/**
 * BankAccountModals — Add / Edit modals for the Bank Accounts page.
 * Both modals offer a "Group" (parent) select so paycards / floats / card
 * machines can be filed under an umbrella bank account. Candidates are the
 * known group umbrellas (derived from existing memberships — the list API
 * only returns leaves) plus any ungrouped account.
 */

import { X, Loader2 } from 'lucide-react';
import type { ParentCandidate } from './parentCandidates';

export { buildParentCandidates, type BankAccountRow, type ParentCandidate } from './parentCandidates';

const inputCls = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-cyan-500';
const labelCls = 'block text-sm font-medium text-[var(--ff-text-secondary)] mb-1';

function GroupSelect({ value, candidates, onChange }: {
  value: string;
  candidates: ParentCandidate[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className={labelCls}>
        Group <span className="text-[var(--ff-text-tertiary)] font-normal">(optional — for paycards / sub-accounts)</span>
      </label>
      <select value={value} onChange={e => onChange(e.target.value)} className={inputCls}>
        <option value="">— None (standalone account) —</option>
        {candidates.map(c => (
          <option key={c.id} value={c.id}>{c.label}</option>
        ))}
      </select>
    </div>
  );
}

export interface AddForm {
  accountCode: string;
  accountName: string;
  description: string;
  bankAccountNumber: string;
  parentAccountId: string;
}

interface AddModalProps {
  form: AddForm;
  setForm: (fn: (f: AddForm) => AddForm) => void;
  candidates: ParentCandidate[];
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

export function AddBankAccountModal({ form, setForm, candidates, saving, onSave, onClose }: AddModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Add Bank Account</h2>
          <button onClick={onClose} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={labelCls}>Account Code *</label>
            <input type="text" name="accountCode" placeholder="e.g. 1114" value={form.accountCode}
              onChange={e => setForm(f => ({ ...f, accountCode: e.target.value }))} className={inputCls} />
          </div>

          <div>
            <label className={labelCls}>Account Name *</label>
            <input type="text" name="accountName" placeholder="e.g. Bank - FNB Current" value={form.accountName}
              onChange={e => setForm(f => ({ ...f, accountName: e.target.value }))} className={inputCls} />
          </div>

          <GroupSelect value={form.parentAccountId} candidates={candidates}
            onChange={v => setForm(f => ({ ...f, parentAccountId: v }))} />

          <div>
            <label className={labelCls}>Bank Account Number</label>
            <input type="text" name="bankAccountNumber" placeholder="e.g. 4078012345" value={form.bankAccountNumber}
              maxLength={50} onChange={e => setForm(f => ({ ...f, bankAccountNumber: e.target.value }))} className={inputCls} />
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Displayed masked (last 4 digits only) for security</p>
          </div>

          <div>
            <label className={labelCls}>Description</label>
            <input type="text" name="description" placeholder="Optional description" value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className={inputCls} />
          </div>

          <p className="text-xs text-[var(--ff-text-tertiary)]">
            Creates a GL account with type &quot;asset&quot; and subtype &quot;bank&quot;. Pick a group to file this
            under an umbrella account (e.g. an employee paycard under &quot;Paycards&quot;).
          </p>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            Cancel
          </button>
          <button onClick={onSave} disabled={saving}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg text-sm flex items-center gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Create Account
          </button>
        </div>
      </div>
    </div>
  );
}

export interface EditForm {
  accountName: string;
  description: string;
  bankAccountNumber: string;
  parentAccountId: string;
}

interface EditModalProps {
  accountCode: string;
  form: EditForm;
  setForm: (fn: (f: EditForm) => EditForm) => void;
  candidates: ParentCandidate[];
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

export function EditBankAccountModal({ accountCode, form, setForm, candidates, saving, onSave, onClose }: EditModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Edit Bank Account</h2>
            <p className="text-xs font-mono text-[var(--ff-text-tertiary)]">GL Code: {accountCode}</p>
          </div>
          <button onClick={onClose} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={labelCls}>Account Name *</label>
            <input type="text" name="accountName" value={form.accountName}
              onChange={e => setForm(f => ({ ...f, accountName: e.target.value }))} className={inputCls} />
          </div>

          <GroupSelect value={form.parentAccountId} candidates={candidates}
            onChange={v => setForm(f => ({ ...f, parentAccountId: v }))} />

          <div>
            <label className={labelCls}>Bank Account Number</label>
            <input type="text" name="bankAccountNumber" placeholder="e.g. 4078012345" value={form.bankAccountNumber}
              maxLength={50} onChange={e => setForm(f => ({ ...f, bankAccountNumber: e.target.value }))} className={inputCls} />
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Displayed masked (last 4 digits only) for security</p>
          </div>

          <div>
            <label className={labelCls}>Description</label>
            <input type="text" name="description" placeholder="Optional description" value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className={inputCls} />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            Cancel
          </button>
          <button onClick={onSave} disabled={saving}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded-lg text-sm flex items-center gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
