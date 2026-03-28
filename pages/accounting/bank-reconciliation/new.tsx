/**
 * Start New Reconciliation Page
 * PRD-060 Phase 4: Create reconciliation session
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Landmark, Loader2 } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface BankAccount { id: string; account_code: string; account_name: string; bank_account_number?: string | null }

export default function NewReconciliationPage() {
  const router = useRouter();
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    bankAccountId: '',
    statementDate: new Date().toISOString().split('T')[0],
    statementBalance: 0,
  });

  useEffect(() => {
    apiFetch('/api/accounting/chart-of-accounts?subtype=bank')
      .then(r => r.json())
      .then(res => {
        const data = res.data || res;
        const accounts = Array.isArray(data) ? data : data.accounts || [];
        setBankAccounts(accounts.map((a: { id: string; accountCode?: string; account_code?: string; accountName?: string; account_name?: string; bankAccountNumber?: string; bank_account_number?: string }) => ({
          id: a.id,
          account_code: a.accountCode || a.account_code || '',
          account_name: a.accountName || a.account_name || '',
          bank_account_number: a.bankAccountNumber || a.bank_account_number || null,
        })));
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      const res = await apiFetch('/api/accounting/bank-reconciliations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          bankAccountId: form.bankAccountId,
          statementDate: form.statementDate,
          statementBalance: form.statementBalance,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || 'Failed to start reconciliation');
      const data = json.data || json;
      router.push(`/accounting/bank-reconciliation/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start reconciliation');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting/bank-reconciliation" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Reconciliations
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Landmark className="h-6 w-6 text-teal-500" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Start Reconciliation</h1>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-2xl space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Reconciliation Setup</h2>

            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Bank Account *</label>
              <select
                value={form.bankAccountId}
                onChange={e => setForm(f => ({ ...f, bankAccountId: e.target.value }))}
                className="ff-select w-full"
                required
              >
                <option value="">Select bank account...</option>
                {bankAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.account_code} — {a.account_name}
                    {a.bank_account_number ? ` (****${a.bank_account_number.slice(-4)})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Statement Date *</label>
                <input
                  type="date"
                  value={form.statementDate}
                  onChange={e => setForm(f => ({ ...f, statementDate: e.target.value }))}
                  className="ff-input w-full"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Statement Closing Balance *</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.statementBalance || ''}
                  onChange={e => setForm(f => ({ ...f, statementBalance: Number(e.target.value) }))}
                  className="ff-input w-full"
                  placeholder="e.g. 125000.00"
                  required
                />
              </div>
            </div>

            <p className="text-xs text-[var(--ff-text-tertiary)]">
              Enter the closing balance from your bank statement. The system will calculate the GL balance
              automatically and show the difference for you to reconcile.
            </p>
          </div>

          <div className="flex justify-end gap-3">
            <Link href="/accounting/bank-reconciliation" className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
              Cancel
            </Link>
            <button
              type="submit"
              disabled={isSubmitting || !form.bankAccountId}
              className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors text-sm font-medium"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Start Reconciliation
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
