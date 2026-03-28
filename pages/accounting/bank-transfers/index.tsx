/**
 * Bank Transfers
 * Sage equivalent: Banking > Transfers
 * Transfer between own bank accounts (creates balanced journal entry)
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeftRight, Loader2, AlertCircle, Plus } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface BankAccount {
  id: string;
  account_code: string;
  account_name: string;
}

export default function BankTransfersPage() {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [fromAccount, setFromAccount] = useState('');
  const [toAccount, setToAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [transferDate, setTransferDate] = useState(new Date().toISOString().split('T')[0]);
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

  useEffect(() => { loadBankAccounts(); }, [loadBankAccounts]);

  const handleTransfer = async () => {
    if (!fromAccount || !toAccount || !amount || fromAccount === toAccount) {
      setMessage({ type: 'error', text: 'Please fill all fields and select different accounts' });
      return;
    }
    setIsSubmitting(true);
    setMessage({ type: '', text: '' });
    try {
      const res = await apiFetch('/api/accounting/bank-transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromAccountId: fromAccount,
          toAccountId: toAccount,
          amount: parseFloat(amount),
          reference,
          transferDate,
        }),
      });
      const json = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: 'Transfer completed — journal entry created' });
        setAmount('');
        setReference('');
      } else {
        setMessage({ type: 'error', text: json.message || 'Transfer failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Transfer request failed' });
    } finally {
      setIsSubmitting(false);
    }
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
                    onChange={(e) => setFromAccount(e.target.value)}
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
                    onChange={(e) => setToAccount(e.target.value)}
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
                    <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Amount (ZAR)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]"
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Date</label>
                    <input
                      type="date"
                      value={transferDate}
                      onChange={(e) => setTransferDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reference</label>
                  <input
                    type="text"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
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
                  className="w-full px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg flex items-center justify-center gap-2 text-sm font-medium"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />}
                  Process Transfer
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
