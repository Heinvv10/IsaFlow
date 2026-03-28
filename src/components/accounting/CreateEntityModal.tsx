/**
 * Inline entity creation modal — create GL Accounts, Suppliers, or Customers
 * directly from the bank transaction allocation dropdown (Sage-style).
 */

import { useState } from 'react';
import { Plus, X, Loader2 } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import type { AllocType } from './BankTxTable';

interface Props {
  type: AllocType;
  onClose: () => void;
  onCreated: (entity: { id: string; code?: string; name: string }) => void;
}

const ACCOUNT_TYPES = [
  { value: 'expense', label: 'Expense', nb: 'debit' },
  { value: 'asset', label: 'Asset', nb: 'debit' },
  { value: 'liability', label: 'Liability', nb: 'credit' },
  { value: 'revenue', label: 'Revenue', nb: 'credit' },
  { value: 'equity', label: 'Equity', nb: 'credit' },
];

const INPUT = 'w-full px-3 py-2 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:border-teal-500';
const LABEL = 'text-xs text-[var(--ff-text-tertiary)] mb-1 block';

export function CreateEntityModal({ type, onClose, onCreated }: Props) {
  const [saving, setSaving] = useState(false);

  // Account fields
  const [acctCode, setAcctCode] = useState('');
  const [acctName, setAcctName] = useState('');
  const [acctType, setAcctType] = useState('expense');

  // Supplier fields
  const [supName, setSupName] = useState('');
  const [supEmail, setSupEmail] = useState('');
  const [supPhone, setSupPhone] = useState('');

  // Customer fields
  const [custName, setCustName] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [custPhone, setCustPhone] = useState('');

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
        if (!res.ok) throw new Error(json.message || json.error?.message || 'Failed to create account');
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
        if (!res.ok) throw new Error(json.message || 'Failed to create supplier');
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
        if (!res.ok) throw new Error(json.message || 'Failed to create customer');
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

  const nb = ACCOUNT_TYPES.find(t => t.value === acctType)?.nb;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--ff-border-light)]">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-teal-400" />
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">{title}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {type === 'account' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Account Code *</label>
                  <input type="text" value={acctCode} onChange={e => setAcctCode(e.target.value)}
                    placeholder="e.g. 5250" className={`${INPUT} font-mono`} autoFocus />
                </div>
                <div>
                  <label className={LABEL}>Type *</label>
                  <select value={acctType} onChange={e => setAcctType(e.target.value)} className={INPUT}>
                    {ACCOUNT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={LABEL}>Account Name *</label>
                <input type="text" value={acctName} onChange={e => setAcctName(e.target.value)}
                  placeholder="e.g. Cleaning & Maintenance" className={INPUT} />
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--ff-text-tertiary)]">
                Normal balance:&nbsp;
                <span className={nb === 'debit' ? 'text-red-400' : 'text-teal-400'}>
                  {nb === 'debit' ? 'Debit' : 'Credit'}
                </span>
              </div>
            </>
          )}

          {type === 'supplier' && (
            <>
              <div>
                <label className={LABEL}>Supplier Name *</label>
                <input type="text" value={supName} onChange={e => setSupName(e.target.value)}
                  placeholder="e.g. ACME Trading" className={INPUT} autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Email *</label>
                  <input type="email" value={supEmail} onChange={e => setSupEmail(e.target.value)}
                    placeholder="info@supplier.co.za" className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Phone</label>
                  <input type="tel" value={supPhone} onChange={e => setSupPhone(e.target.value)}
                    placeholder="012 345 6789" className={INPUT} />
                </div>
              </div>
            </>
          )}

          {type === 'customer' && (
            <>
              <div>
                <label className={LABEL}>Company Name *</label>
                <input type="text" value={custName} onChange={e => setCustName(e.target.value)}
                  placeholder="e.g. Fibertime" className={INPUT} autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Email</label>
                  <input type="email" value={custEmail} onChange={e => setCustEmail(e.target.value)}
                    placeholder="client@example.com" className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Phone</label>
                  <input type="tel" value={custPhone} onChange={e => setCustPhone(e.target.value)}
                    placeholder="012 345 6789" className={INPUT} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
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
