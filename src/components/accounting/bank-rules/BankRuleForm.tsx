/**
 * Create / edit form for a bank-categorisation rule. Extracted out of the
 * rules page so the page itself stays under the 300-line per-file budget.
 */

import { Loader2 } from 'lucide-react';
import type { VatCode } from './BankRuleRow';
import type { PreviewState } from './useBankRules';

export interface BankRuleFormState {
  ruleName: string;
  matchField: string;
  matchType: string;
  matchPattern: string;
  glAccountId: string;
  supplierId: string;
  clientId: string;
  vatCode: string;
  descriptionTemplate: string;
  priority: string;
  autoCreateEntry: boolean;
}

export interface GLAccountOption {
  id: string;
  accountCode: string;
  accountName: string;
  defaultVatCode?: string;
}

interface BankRuleFormProps {
  form: BankRuleFormState;
  setForm: React.Dispatch<React.SetStateAction<BankRuleFormState>>;
  isEditing: boolean;
  busy: string;
  accounts: GLAccountOption[];
  suppliers: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  previewState: PreviewState;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}

export function BankRuleForm({
  form,
  setForm,
  isEditing,
  busy,
  accounts,
  suppliers,
  clients,
  previewState,
  onSubmit,
  onCancel,
}: BankRuleFormProps) {
  return (
    <form
      onSubmit={onSubmit}
      className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4"
    >
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
        {isEditing ? 'Edit Categorisation Rule' : 'New Categorisation Rule'}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <input
          value={form.ruleName}
          onChange={e => setForm(f => ({ ...f, ruleName: e.target.value }))}
          className="ff-input"
          placeholder="Rule Name *"
          required
          aria-label="Rule name"
        />
        <select
          value={form.matchField}
          onChange={e => setForm(f => ({ ...f, matchField: e.target.value }))}
          className="ff-select"
          aria-label="Match field"
        >
          <option value="description">Match Description</option>
          <option value="reference">Match Reference</option>
          <option value="both">Match Both</option>
        </select>
        <select
          value={form.matchType}
          onChange={e => setForm(f => ({ ...f, matchType: e.target.value }))}
          className="ff-select"
          aria-label="Match type"
        >
          <option value="contains">Contains</option>
          <option value="starts_with">Starts With</option>
          <option value="ends_with">Ends With</option>
          <option value="exact">Exact Match</option>
        </select>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <input
            value={form.matchPattern}
            onChange={e => setForm(f => ({ ...f, matchPattern: e.target.value }))}
            className="ff-input w-full"
            placeholder="Pattern (e.g. WOOLWORTHS) *"
            required
            aria-label="Pattern"
          />
          {form.matchPattern.trim() && (
            <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">
              {previewState.status === 'loading' && 'Checking matches…'}
              {previewState.status === 'idle' && null}
              {previewState.status === 'error' && (
                <span className="text-amber-400">Match preview unavailable</span>
              )}
              {previewState.status === 'ready' && (
                <span className={previewState.count > 0 ? 'text-teal-400' : 'text-[var(--ff-text-tertiary)]'}>
                  {previewState.count} unreviewed transaction{previewState.count !== 1 ? 's' : ''} would match
                </span>
              )}
            </p>
          )}
        </div>
        <select
          value={form.glAccountId}
          onChange={e => {
            const acct = accounts.find(a => a.id === e.target.value);
            setForm(f => ({
              ...f,
              glAccountId: e.target.value,
              vatCode: acct?.defaultVatCode && f.vatCode === 'none'
                ? acct.defaultVatCode as VatCode
                : f.vatCode,
            }));
          }}
          className="ff-select"
          required={!form.supplierId && !form.clientId}
          aria-label="GL account"
        >
          <option value="">{form.supplierId || form.clientId ? 'No GL Account (optional)' : 'Select GL Account *'}</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>)}
        </select>
        <input
          type="number"
          value={form.priority}
          onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
          className="ff-input"
          placeholder="Priority (lower = first)"
          aria-label="Priority"
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <select
          value={form.supplierId}
          onChange={e => setForm(f => ({ ...f, supplierId: e.target.value, clientId: '' }))}
          className="ff-select"
          aria-label="Supplier"
        >
          <option value="">No Supplier (optional)</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select
          value={form.clientId}
          onChange={e => setForm(f => ({ ...f, clientId: e.target.value, supplierId: '' }))}
          className="ff-select"
          aria-label="Customer"
        >
          <option value="">No Customer (optional)</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={form.vatCode}
          onChange={e => setForm(f => ({ ...f, vatCode: e.target.value }))}
          className="ff-select"
          aria-label="VAT code"
        >
          <option value="">No VAT</option>
          <option value="standard">Standard 15%</option>
          <option value="zero_rated">Zero Rated</option>
          <option value="exempt">Exempt</option>
        </select>
        <input
          value={form.descriptionTemplate}
          onChange={e => setForm(f => ({ ...f, descriptionTemplate: e.target.value }))}
          className="ff-input"
          placeholder="Description template (optional)"
          aria-label="Description template"
        />
      </div>
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/40 p-3">
        <input
          type="checkbox"
          checked={form.autoCreateEntry}
          onChange={e => setForm(f => ({ ...f, autoCreateEntry: e.target.checked }))}
          className="mt-0.5 accent-amber-500"
        />
        <span className="text-xs text-[var(--ff-text-secondary)]">
          Auto-post journal entries when this rule matches
          <span className="mt-0.5 block text-[11px] text-[var(--ff-text-muted)]">
            Off (Suggest): rule attaches a category for review only. On (Auto-post): rule also posts a journal entry on every match — confirm the GL account / supplier / customer is correct.
          </span>
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy === 'new'}
          className="px-6 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : (isEditing ? 'Save Changes' : 'Create Rule')}
        </button>
      </div>
    </form>
  );
}
