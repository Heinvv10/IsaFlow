/**
 * AddConnectionModal — modal form for creating a new open banking connection.
 * Provider picker (radio) + optional bank account selector + external account ID.
 */

import { useState } from 'react';
import { XCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import {
  PROVIDER_LABELS, PROVIDER_DESCRIPTIONS,
  type Provider, type BankAccount,
} from './bankFeedTypes';

const PROVIDERS: Provider[] = ['manual_csv', 'basiq', 'tink', 'plaid'];

interface Props {
  bankAccounts: BankAccount[];
  onClose: () => void;
  onCreated: () => void;
}

export function AddConnectionModal({ bankAccounts, onClose, onCreated }: Props) {
  const [provider, setProvider] = useState<Provider>('manual_csv');
  const [accountId, setAccountId] = useState('');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { provider };
      if (accountId) body.accountId = accountId;
      if (externalAccountId) body.externalAccountId = externalAccountId;

      const res = await apiFetch('/api/accounting/bank-feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || 'Failed to create connection');
      notify.success('Bank feed connection created');
      onCreated();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Failed to create connection');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--ff-border-primary)]">
          <h2 className="text-lg font-bold text-[var(--ff-text-primary)]">Add Bank Feed Connection</h2>
          <button onClick={onClose} className="p-1.5 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            <XCircle className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-2">
              Provider <span className="text-red-400">*</span>
            </label>
            <div className="space-y-2">
              {PROVIDERS.map(p => (
                <label
                  key={p}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    provider === p
                      ? 'border-teal-500 bg-teal-500/10'
                      : 'border-[var(--ff-border-primary)] hover:border-[var(--ff-border-hover)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="provider"
                    value={p}
                    checked={provider === p}
                    onChange={() => setProvider(p)}
                    className="mt-0.5 accent-teal-500"
                  />
                  <div>
                    <p className="text-sm font-medium text-[var(--ff-text-primary)]">{PROVIDER_LABELS[p]}</p>
                    <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5">{PROVIDER_DESCRIPTIONS[p]}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {bankAccounts.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1.5">
                Linked Bank Account
              </label>
              <select
                value={accountId}
                onChange={e => setAccountId(e.target.value)}
                className="ff-input w-full"
              >
                <option value="">— Select a bank account —</option>
                {bankAccounts.map(a => (
                  <option key={a.id} value={a.id}>{a.accountName}</option>
                ))}
              </select>
            </div>
          )}

          {provider !== 'manual_csv' && (
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1.5">
                External Account ID
                <span className="ml-1 text-xs text-[var(--ff-text-tertiary)]">(optional)</span>
              </label>
              <input
                type="text"
                value={externalAccountId}
                onChange={e => setExternalAccountId(e.target.value)}
                placeholder={`Your ${PROVIDER_LABELS[provider]} account ID`}
                className="ff-input w-full"
              />
            </div>
          )}

          {provider === 'manual_csv' && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              <p className="text-sm text-amber-400">
                Manual CSV connections do not auto-sync. Use the{' '}
                <strong>Import Statement</strong> page to upload your bank statement files.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-5 border-t border-[var(--ff-border-primary)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Add Connection
          </button>
        </div>
      </div>
    </div>
  );
}
