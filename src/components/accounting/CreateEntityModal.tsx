/**
 * Inline entity creation modal — create GL Accounts, Suppliers, or Customers
 * directly from the bank transaction allocation dropdown (Sage-style).
 */

import { useState, useEffect, useCallback } from 'react';
import { Plus, X, Loader2 } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import type { AllocType, SelectOption } from './BankTxTable';
import { AccountForm } from './createEntity/AccountForm';
import { SupplierForm } from './createEntity/SupplierForm';
import { CustomerForm } from './createEntity/CustomerForm';
import {
  ACCOUNT_TYPES,
  suggestFromDescription,
  suggestFromType,
  type GLSuggestion,
} from './createEntity/glAccountSuggestions';

interface Props {
  type: AllocType;
  transactionDescription?: string;
  existingAccounts?: SelectOption[];
  onClose: () => void;
  onCreated: (entity: { id: string; code?: string; name: string }) => void;
}

export function CreateEntityModal({ type, transactionDescription, existingAccounts, onClose, onCreated }: Props) {
  const [saving, setSaving] = useState(false);

  const [acctCode, setAcctCode] = useState('');
  const [acctName, setAcctName] = useState('');
  const [acctType, setAcctType] = useState('expense');

  const [suggestion, setSuggestion] = useState<GLSuggestion | null>(null);
  const [suggestionApplied, setSuggestionApplied] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);

  const [supName, setSupName] = useState('');
  const [supEmail, setSupEmail] = useState('');
  const [supPhone, setSupPhone] = useState('');

  const [custName, setCustName] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [custPhone, setCustPhone] = useState('');

  // Live suggestion: refreshes whenever the type, name, or description changes.
  // Description match wins when the user hasn't typed a name yet; once they
  // start typing, slot the code alphabetically among existing accounts of the
  // chosen type.
  useEffect(() => {
    if (type !== 'account' || suggestionDismissed || suggestionApplied) return;

    const trimmedName = acctName.trim();
    const descSuggestion = suggestFromDescription(transactionDescription);

    if (descSuggestion && descSuggestion.type === acctType && !trimmedName) {
      setSuggestion(descSuggestion);
      return;
    }
    setSuggestion(suggestFromType(acctType, trimmedName, existingAccounts));
  }, [type, acctType, acctName, transactionDescription, existingAccounts, suggestionDismissed, suggestionApplied]);

  const findExistingAccount = useCallback((s: GLSuggestion | null): SelectOption | null => {
    if (!s || !existingAccounts?.length) return null;
    return existingAccounts.find(a => a.code === s.code) ?? null;
  }, [existingAccounts]);

  const applySuggestion = useCallback(() => {
    if (!suggestion) return;
    const existing = findExistingAccount(suggestion);
    if (existing) {
      notify.success(`Selected existing account: ${existing.code} ${existing.name}`);
      onCreated({ id: existing.id, code: existing.code, name: existing.name });
      return;
    }
    setAcctCode(suggestion.code);
    setAcctName(suggestion.name);
    setAcctType(suggestion.type);
    setSuggestionApplied(true);
  }, [suggestion, findExistingAccount, onCreated]);

  const dismissSuggestion = useCallback(() => {
    setSuggestion(null);
    setSuggestionDismissed(true);
    setSuggestionApplied(false);
  }, []);

  // Re-engaging the form (editing name or changing type) re-opens suggestions
  // even if previously dismissed/applied — otherwise the user can get stuck
  // with stale or no suggestions for the rest of the modal's lifetime.
  const handleAcctName = useCallback((v: string) => {
    setAcctName(v);
    if (suggestionApplied) setSuggestionApplied(false);
    if (suggestionDismissed) setSuggestionDismissed(false);
  }, [suggestionApplied, suggestionDismissed]);

  const handleAcctType = useCallback((v: string) => {
    setAcctType(v);
    if (suggestionApplied) setSuggestionApplied(false);
    if (suggestionDismissed) setSuggestionDismissed(false);
  }, [suggestionApplied, suggestionDismissed]);

  const title = type === 'account' ? 'New GL Account'
    : type === 'supplier' ? 'New Supplier' : 'New Customer';

  const canSave = type === 'account'
    ? !!(acctCode.trim() && acctName.trim())
    : type === 'supplier'
      ? !!(supName.trim() && supEmail.trim())
      : !!custName.trim();

  const handleSave = async () => {
    setSaving(true);
    try {
      let entity: { id: string; code?: string; name: string };

      if (type === 'account') {
        const nb = ACCOUNT_TYPES.find(t => t.value === acctType)?.nb || 'debit';
        const res = await apiFetch('/api/accounting/chart-of-accounts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountCode: acctCode.trim(), accountName: acctName.trim(),
            accountType: acctType, normalBalance: nb,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || 'Failed to create account');
        const d = json.data;
        entity = { id: d.id, code: d.accountCode, name: d.accountName };
      } else if (type === 'supplier') {
        const res = await apiFetch('/api/suppliers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: {
            name: supName.trim(),
            email: supEmail.trim(),
            phone: supPhone.trim() || undefined,
          }}),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || 'Failed to create supplier');
        const d = json.data;
        entity = { id: String(d.id), code: d.code, name: supName.trim() };
      } else {
        const res = await apiFetch('/api/clients', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_name: custName.trim(),
            email: custEmail.trim() || undefined,
            phone: custPhone.trim() || undefined,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || 'Failed to create customer');
        const d = json.data;
        entity = { id: d.id, name: custName.trim() };
      }

      notify.success(`${title.replace('New ', '')} created`);
      onCreated(entity);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Failed to create');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--ff-border-light)]">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-teal-400" />
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">{title}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {type === 'account' && (
            <AccountForm
              code={acctCode}
              name={acctName}
              type={acctType}
              onCode={setAcctCode}
              onName={handleAcctName}
              onType={handleAcctType}
              transactionDescription={transactionDescription}
              suggestion={suggestion}
              suggestionApplied={suggestionApplied}
              existingMatch={findExistingAccount(suggestion)}
              onApplySuggestion={applySuggestion}
              onDismissSuggestion={dismissSuggestion}
            />
          )}
          {type === 'supplier' && (
            <SupplierForm
              name={supName} email={supEmail} phone={supPhone}
              onName={setSupName} onEmail={setSupEmail} onPhone={setSupPhone}
            />
          )}
          {type === 'customer' && (
            <CustomerForm
              name={custName} email={custEmail} phone={custPhone}
              onName={setCustName} onEmail={setCustEmail} onPhone={setCustPhone}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--ff-border-light)]">
          <button onClick={onClose}
            className="px-4 py-1.5 rounded text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !canSave}
            className="px-4 py-1.5 rounded bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium flex items-center gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
