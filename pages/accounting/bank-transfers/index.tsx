/**
 * Bank Transfers
 * Sage equivalent: Banking > Transfers
 * Transfer between own bank accounts (creates balanced journal entry)
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeftRight, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage, ApiRequestError } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { isBankSubtype } from '@/modules/accounting/services/gl/accountSubtypes';

/** The chart-of-accounts GET answers its accounts camelCased, as a plain array. */
interface BankAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountSubtype?: string;
}

export default function BankTransfersPage() {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [fromAccount, setFromAccount] = useState('');
  const [toAccount, setToAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [transferDate, setTransferDate] = useState(localISODate());
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 428 from the route: the statement may already hold this transfer; posting again needs the person's confirmation.
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState({ type: '', text: '' });

  const loadBankAccounts = useCallback(async () => {
    setIsLoading(true);
    try {
      // Every bank spelling the transfer route accepts (isBankSubtype: 'bank', 'bank_account', …), not only 'bank'.
      const res = await apiFetch('/api/accounting/chart-of-accounts');
      await assertOk(res, 'Could not load bank accounts - try again');
      const json = await res.json();
      const accounts: BankAccount[] = Array.isArray(json.data) ? json.data : [];
      setBankAccounts(accounts.filter(a => isBankSubtype(a.accountSubtype)));
    } catch (err) {
      setBankAccounts([]);
      setMessage({ type: 'error', text: apiErrorMessage(err, 'Could not load bank accounts - try again') });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadBankAccounts(); }, [loadBankAccounts]);
  // The confirmation covers the transfer the person was warned about, not an edited one (brk-nrfa round 4 LOW-2).
  useEffect(() => { setNeedsConfirm(false); }, [fromAccount, toAccount, amount, transferDate]);

  const handleTransfer = async (confirmDuplicate = false) => {
    if (!fromAccount || !toAccount || !amount || fromAccount === toAccount) {
      setMessage({ type: 'error', text: 'Please fill all fields and select different accounts' });
      return;
    }
    setIsSubmitting(true);
    setNeedsConfirm(false);
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
          ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
        }),
      });
      await assertOk(res, 'Could not record the transfer - try again');
      setMessage({ type: 'success', text: 'Transfer completed — journal entry created' });
      setAmount('');
      setReference('');
    } catch (err) {
      setNeedsConfirm(err instanceof ApiRequestError && err.status === 428);
      setMessage({ type: 'error', text: apiErrorMessage(err, 'Could not record the transfer - try again') });
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
                      <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>
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
                      <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>
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

                {needsConfirm && (
                  <button
                    onClick={() => { void handleTransfer(true); }}
                    disabled={isSubmitting}
                    className="w-full px-4 py-2.5 border border-amber-500/60 text-amber-400 hover:bg-amber-500/10 disabled:opacity-50 rounded-lg text-sm font-medium"
                  >
                    It is a separate transfer — post it anyway
                  </button>
                )}

                <button
                  onClick={() => { void handleTransfer(); }}
                  disabled={isSubmitting}
                  className="w-full px-4 py-2.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg flex items-center justify-center gap-2 text-sm font-medium"
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
