/**
 * AddConnectionModal — modal form for creating a new open banking connection.
 * Provider picker (radio) + optional bank account selector + external account ID.
 *
 * The 'extension' provider has its own pair-with-extension flow that mints
 * a pairing JWT and posts it to the IsaFlow Bank Connector Chrome extension
 * via window.postMessage.
 */

import { useEffect, useState } from 'react';
import { XCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import {
  PROVIDER_LABELS, PROVIDER_DESCRIPTIONS,
  type Provider, type BankAccount,
} from './bankFeedTypes';

const PROVIDERS: Provider[] = ['extension', 'manual_csv', 'basiq', 'tink', 'plaid'];
const EXTENSION_BANKS: Array<{ id: string; label: string }> = [
  { id: 'absa', label: 'ABSA Business Banking' },
];
const CHROME_WEB_STORE_URL = 'https://chrome.google.com/webstore/detail/isaflow-bank-connector';

interface Props {
  bankAccounts: BankAccount[];
  onClose: () => void;
  onCreated: () => void;
}

interface PairResponse {
  connectionId: string;
  bankId: string;
  jwt: string;
  ingestUrl: string;
}

export function AddConnectionModal({ bankAccounts, onClose, onCreated }: Props) {
  const [provider, setProvider] = useState<Provider>('extension');
  const [accountId, setAccountId] = useState('');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [bankId, setBankId] = useState<string>('absa');
  const [extensionDetected, setExtensionDetected] = useState(false);
  const [saving, setSaving] = useState(false);

  // Detect the bank-connector extension by listening for its `announce` postMessage.
  useEffect(() => {
    if (provider !== 'extension') return;
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { source?: string; type?: string } | null;
      if (d?.source === 'isaflow-bank-extension' && d?.type === 'announce') {
        setExtensionDetected(true);
      }
    };
    window.addEventListener('message', onMsg);
    // Probe — the extension answers `announce` on focus too.
    window.postMessage({ source: 'isaflow-bank-page', type: 'isaflow-bank-ext-ping' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, [provider]);

  const handleExtensionPair = async () => {
    if (!accountId) {
      notify.error('Pick the IsaFlow bank account this connection feeds into.');
      return;
    }
    if (!externalAccountId) {
      notify.error('Enter the bank-side account number to pair.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/bank-feeds/extension-pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankId,
          bankAccountId: accountId,
          externalAccountId,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || 'Failed to pair extension');
      const data = (json?.data ?? json) as PairResponse;

      window.postMessage({
        source: 'isaflow-bank-page',
        type: 'isaflow-bank-ext-pair',
        requestId: 'pair-' + data.connectionId,
        payload: {
          connectionId: data.connectionId,
          jwt: data.jwt,
          ingestUrl: data.ingestUrl,
          bankId: data.bankId,
          bankAccountExternalId: externalAccountId,
          host: window.location.origin,
        },
      }, '*');

      notify.success('Extension paired. Open your bank tab to sync.');
      onCreated();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Pairing failed');
    } finally {
      setSaving(false);
    }
  };

  const handleClassicSubmit = async () => {
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

  const handleSubmit = () => {
    if (provider === 'extension') return handleExtensionPair();
    return handleClassicSubmit();
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

          {provider === 'extension' && (
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1.5">Bank</label>
              <select value={bankId} onChange={e => setBankId(e.target.value)} className="ff-input w-full">
                {EXTENSION_BANKS.map(b => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
              </select>
            </div>
          )}

          {bankAccounts.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1.5">
                Linked Bank Account {provider === 'extension' && <span className="text-red-400">*</span>}
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
                {provider === 'extension' ? 'Bank Account Number' : 'External Account ID'}
                {provider === 'extension'
                  ? <span className="ml-1 text-red-400">*</span>
                  : <span className="ml-1 text-xs text-[var(--ff-text-tertiary)]">(optional)</span>}
              </label>
              <input
                type="text"
                value={externalAccountId}
                onChange={e => setExternalAccountId(e.target.value)}
                placeholder={
                  provider === 'extension'
                    ? 'Your bank account number'
                    : `Your ${PROVIDER_LABELS[provider]} account ID`
                }
                className="ff-input w-full"
              />
            </div>
          )}

          {provider === 'extension' && !extensionDetected && (
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
              <p className="text-sm text-blue-400">
                Install the{' '}
                <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noreferrer" className="underline">
                  IsaFlow Bank Connector
                </a>
                {' '}Chrome extension first. After install, return here and click <strong>Pair</strong>.
              </p>
            </div>
          )}
          {provider === 'extension' && extensionDetected && (
            <div className="bg-teal-500/10 border border-teal-500/30 rounded-lg p-3">
              <p className="text-sm text-teal-400">
                Extension detected. Clicking <strong>Pair</strong> stores a 90-day token in the extension and creates a connection here. After pairing, log into your bank in another tab and use the extension popup to sync.
              </p>
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
            disabled={saving || (provider === 'extension' && !extensionDetected)}
            className="flex items-center gap-2 px-5 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {provider === 'extension' ? 'Pair Extension' : 'Add Connection'}
          </button>
        </div>
      </div>
    </div>
  );
}
