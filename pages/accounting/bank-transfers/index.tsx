/**
 * Bank Transfers
 * Sage equivalent: Banking > Transfers
 * Transfer between own bank accounts (creates balanced journal entry)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeftRight, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface BankAccount {
  id: string;
  account_code: string;
  account_name: string;
}
interface PreparedTransfer { inputRevision: number; fromLabel: string; toLabel: string; intentId: string; requiresApproval: boolean; amount: string; currency: string; accountingDate: string }

export default function BankTransfersPage() {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [fromAccount, setFromAccount] = useState('');
  const [toAccount, setToAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [transferDate, setTransferDate] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date()));
  const [prepared, setPrepared] = useState<PreparedTransfer | null>(null);
  const inputRevision = useRef(0);
  const invalidatePreparation = () => { inputRevision.current += 1; setPrepared(null); setApprovalId(''); };
  const [approvalId, setApprovalId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState({ type: '', text: '' });

  const loadBankAccounts = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts?subtype=bank');
      const json = await res.json();
      const data = json.data || json;
      setBankAccounts(data.accounts || []);
    } catch {
      setMessage({ type: 'error', text: 'Failed to load bank accounts' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadBankAccounts(); }, [loadBankAccounts]);

  const handleTransfer = async () => {
    if (!fromAccount || !toAccount || !amount || fromAccount === toAccount) {
      setMessage({ type: 'error', text: 'Please fill all fields and select different accounts' });
      return;
    }
    const revision = inputRevision.current;
    const fromLabel = bankAccounts.find(account => account.id === fromAccount)?.account_name ?? fromAccount;
    const toLabel = bankAccounts.find(account => account.id === toAccount)?.account_name ?? toAccount;
    setIsSubmitting(true);
    setMessage({ type: '', text: '' });
    try {
      const res = await apiFetch('/api/accounting/bank-transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromAccountId: fromAccount,
          toAccountId: toAccount,
          amount,
          reference,
          transferDate,
        }),
      });
      const json = await res.json();
      if (revision !== inputRevision.current) return;
      if (res.ok) {
        const data = json.data;
        if (!data?.intentId || !['prepared', 'approval_required'].includes(data.status)) throw new Error('Unexpected preparation response');
        setPrepared({ ...data, inputRevision: revision, fromLabel, toLabel });
        setMessage({ type: 'success', text: data.requiresApproval ? 'Transfer prepared; independent approval required.' : 'Transfer prepared. Review the details before posting.' });
      } else {
        setMessage({ type: 'error', text: json.message || 'Transfer failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Transfer request failed' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePost = async () => {
    if (!prepared || prepared.inputRevision !== inputRevision.current || (prepared.requiresApproval && !approvalId.trim())) return;
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/bank-transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute', intentId: prepared.intentId, ...(approvalId.trim() ? { approvalId: approvalId.trim() } : {}) }) });
      const json = await res.json();
      if (!res.ok) { setMessage({ type: 'error', text: json.message || 'Transfer could not be posted' }); return; }
      if (json.data?.status !== 'posted' || !json.data.journalEntryId) throw new Error('Posting outcome unavailable');
      setMessage({ type: 'success', text: `Transfer completed. Journal ${json.data.journalEntryId} posted.` });
      setPrepared(null); setAmount(''); setReference('');
      await loadBankAccounts();
    } catch {
      setMessage({ type: 'error', text: 'Posting outcome unavailable. Keep this prepared intent and check its status before retrying.' });
    } finally { setIsSubmitting(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <ArrowLeftRight className="h-6 w-6 text-indigo-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Bank Transfers</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Transfer funds between bank accounts
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-2xl">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
            </div>
          ) : (
            <div className="space-y-6">
              <div className="p-6 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] space-y-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">From Account</label>
                  <select
                    value={fromAccount}
                    onChange={(e) => { invalidatePreparation(); setFromAccount(e.target.value); }}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]"
                  >
                    <option value="">Select source account...</option>
                    {bankAccounts.map(a => (
                      <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex justify-center">
                  <ArrowLeftRight className="h-6 w-6 text-[var(--ff-text-tertiary)]" />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">To Account</label>
                  <select
                    value={toAccount}
                    onChange={(e) => { invalidatePreparation(); setToAccount(e.target.value); }}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]"
                  >
                    <option value="">Select destination account...</option>
                    {bankAccounts.map(a => (
                      <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Amount (account currency)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={amount}
                      onChange={(e) => { invalidatePreparation(); setAmount(e.target.value); }}
                      className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]"
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Date</label>
                    <input
                      type="date"
                      value={transferDate}
                      onChange={(e) => { invalidatePreparation(); setTransferDate(e.target.value); }}
                      className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reference</label>
                  <input
                    type="text"
                    value={reference}
                    onChange={(e) => { invalidatePreparation(); setReference(e.target.value); }}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]"
                    placeholder="e.g. Inter-account transfer"
                  />
                </div>

                {message.text && (
                  <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
                    message.type === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-teal-500/10 text-teal-400'
                  }`}>
                    <AlertCircle className="h-4 w-4" />
                    {message.text}
                  </div>
                )}

                <button
                  onClick={handleTransfer}
                  disabled={isSubmitting}
                  className="w-full px-4 py-2.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg flex items-center justify-center gap-2 text-sm font-medium"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />}
                  Prepare Transfer
                </button>
                {prepared && <div className="space-y-3 text-sm text-[var(--ff-text-primary)]">
                  <p>Prepared: {prepared.currency} {prepared.amount} on {prepared.accountingDate}</p>
                  <p>Intent: {prepared.intentId}</p>
                  <p>From {prepared.fromLabel} to {prepared.toLabel}</p>
                  <label className="block">Approval reference{prepared.requiresApproval ? ' (required)' : ' (optional)'}
                    <input value={approvalId} onChange={event => setApprovalId(event.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)]" />
                  </label>
                  <button onClick={handlePost} disabled={isSubmitting || (prepared.requiresApproval && !approvalId.trim())}
                    className="w-full px-4 py-2.5 bg-teal-600 disabled:opacity-50 text-white rounded-lg">Post Prepared Transfer</button>
                </div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
