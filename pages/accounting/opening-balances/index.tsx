/**
 * Opening Balances
 * Sage equivalent: Accountant's Area > Opening Balances
 * Set opening balances for GL accounts (used during migration/setup)
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { BookMarked, Loader2, AlertCircle, Save } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

interface AccountBalance {
  id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  normal_balance: string;
  opening_debit: number;
  opening_credit: number;
}

export default function OpeningBalancesPage() {
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/accounting/opening-balances');
      const json = await res.json();
      const data = json.data || json;
      setAccounts(data.accounts || []);
    } catch {
      setMessage({ type: 'error', text: 'Failed to load accounts' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const updateBalance = (id: string, field: 'opening_debit' | 'opening_credit', value: string) => {
    setAccounts(prev => prev.map(a =>
      a.id === id ? { ...a, [field]: parseFloat(value) || 0 } : a
    ));
  };

  const totalDebits = accounts.reduce((sum, a) => sum + (a.opening_debit || 0), 0);
  const totalCredits = accounts.reduce((sum, a) => sum + (a.opening_credit || 0), 0);
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;

  const handleSave = async () => {
    if (!isBalanced) {
      setMessage({ type: 'error', text: 'Debits must equal credits before saving' });
      return;
    }
    setIsSaving(true);
    setMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/accounting/opening-balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          balances: accounts.filter(a => a.opening_debit > 0 || a.opening_credit > 0).map(a => ({
            accountId: a.id,
            debit: a.opening_debit,
            credit: a.opening_credit,
          })),
        }),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: 'Opening balances saved as journal entry' });
      } else {
        const json = await res.json();
        setMessage({ type: 'error', text: json.message || 'Failed to save' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Save request failed' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <BookMarked className="h-6 w-6 text-teal-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Opening Balances</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Set account balances for the start of a new fiscal year
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ExportCSVButton endpoint="/api/accounting/opening-balances-export" filenamePrefix="opening-balances" label="Export CSV" />
                <button
                  onClick={handleSave}
                  disabled={isSaving || !isBalanced}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm"
                >
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save Opening Balances
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6">
          {/* Balance indicator */}
          <div className={`flex items-center gap-4 p-4 rounded-lg mb-6 ${isBalanced ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
            <div className="flex-1 grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-[var(--ff-text-secondary)]">Total Debits:</span>
                <span className="ml-2 font-mono font-bold text-[var(--ff-text-primary)]">{formatCurrency(totalDebits)}</span>
              </div>
              <div>
                <span className="text-[var(--ff-text-secondary)]">Total Credits:</span>
                <span className="ml-2 font-mono font-bold text-[var(--ff-text-primary)]">{formatCurrency(totalCredits)}</span>
              </div>
              <div>
                <span className="text-[var(--ff-text-secondary)]">Difference:</span>
                <span className={`ml-2 font-mono font-bold ${isBalanced ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatCurrency(Math.abs(totalDebits - totalCredits))}
                </span>
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : (
            <>
              {message.text && (
                <div className={`flex items-center gap-2 p-3 rounded-lg text-sm mb-4 ${
                  message.type === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
                }`}>
                  <AlertCircle className="h-4 w-4" />
                  {message.text}
                </div>
              )}

              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Code</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Account Name</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Type</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Debit</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((acct) => (
                    <tr key={acct.id} className="border-b border-[var(--ff-border-light)]">
                      <td className="py-2 px-4 font-mono text-[var(--ff-text-tertiary)]">{acct.account_code}</td>
                      <td className="py-2 px-4 text-[var(--ff-text-primary)]">{acct.account_name}</td>
                      <td className="py-2 px-4 text-[var(--ff-text-secondary)] capitalize">{acct.account_type}</td>
                      <td className="py-2 px-4 text-right">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={acct.opening_debit || ''}
                          onChange={(e) => updateBalance(acct.id, 'opening_debit', e.target.value)}
                          className="w-32 px-2 py-1 text-right rounded bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
                          placeholder="0.00"
                        />
                      </td>
                      <td className="py-2 px-4 text-right">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={acct.opening_credit || ''}
                          onChange={(e) => updateBalance(acct.id, 'opening_credit', e.target.value)}
                          className="w-32 px-2 py-1 text-right rounded bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
                          placeholder="0.00"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
