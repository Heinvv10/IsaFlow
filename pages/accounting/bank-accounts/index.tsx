/**
 * Bank Accounts Management
 * Sage equivalent: Banking > Bank Accounts
 * View and manage bank accounts linked to GL
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Landmark, Loader2, AlertCircle, Plus, ArrowUpRight, ArrowDownRight, X, Pencil } from 'lucide-react';
import { toast } from 'react-hot-toast';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

/** Mask account number for display: show last 4 digits only */
function maskAccountNumber(num: string): string {
  if (num.length <= 4) return num;
  return '****' + num.slice(-4);
}

interface BankAccount {
  id: string;
  accountCode: string;
  accountName: string;
  description?: string;
  bankAccountNumber?: string | null;
  isActive: boolean;
  txnCount: number;
  totalDebits: number;
  totalCredits: number;
  balance: number;
  firstDate?: string;
  lastDate?: string;
}

interface EditForm {
  accountName: string;
  description: string;
  bankAccountNumber: string;
}

export default function BankAccountsPage() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ accountCode: '', accountName: '', description: '', bankAccountNumber: '' });

  const [editingAccount, setEditingAccount] = useState<BankAccount | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ accountName: '', description: '', bankAccountNumber: '' });

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/accounting/bank-accounts');
      const json = await res.json();
      const data = json.data || json;
      setAccounts(Array.isArray(data) ? data : []);
    } catch {
      setError('Failed to load bank accounts');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const handleAdd = async () => {
    if (!form.accountCode || !form.accountName) {
      toast.error('Account code and name are required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/accounting/chart-of-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          accountCode: form.accountCode,
          accountName: form.accountName,
          accountType: 'asset',
          accountSubtype: 'bank',
          parentAccountId: 'bf801b3b-de70-4c10-8d8f-689de8b8a9ad',
          description: form.description || form.accountName,
          normalBalance: 'debit',
        }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        toast.error(json.message || json.error || 'Failed to create account');
        return;
      }
      // If bank account number provided, save it separately
      if (form.bankAccountNumber.trim()) {
        const created = json.data || json;
        await fetch('/api/accounting/bank-accounts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id: created.id, bankAccountNumber: form.bankAccountNumber.trim() }),
        });
      }
      toast.success('Bank account created');
      setShowAddModal(false);
      setForm({ accountCode: '', accountName: '', description: '', bankAccountNumber: '' });
      loadAccounts();
    } catch {
      toast.error('Failed to create bank account');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (acct: BankAccount) => {
    setEditingAccount(acct);
    setEditForm({
      accountName: acct.accountName,
      description: acct.description || '',
      bankAccountNumber: acct.bankAccountNumber || '',
    });
  };

  const handleSaveEdit = async () => {
    if (!editingAccount) return;
    if (!editForm.accountName.trim()) {
      toast.error('Account name is required');
      return;
    }
    setSaving(true);
    try {
      // Update name & description via chart-of-accounts
      const coaRes = await fetch('/api/accounting/chart-of-accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: editingAccount.id,
          accountName: editForm.accountName.trim(),
          description: editForm.description.trim() || null,
        }),
      });
      if (!coaRes.ok) {
        const json = await coaRes.json();
        toast.error(json.message || 'Failed to update account');
        return;
      }
      // Update bank account number
      await fetch('/api/accounting/bank-accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: editingAccount.id,
          bankAccountNumber: editForm.bankAccountNumber.trim() || null,
        }),
      });
      toast.success('Bank account updated');
      setEditingAccount(null);
      loadAccounts();
    } catch {
      toast.error('Failed to update bank account');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10">
                  <Landmark className="h-6 w-6 text-cyan-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Bank Accounts</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Manage bank accounts and view balances
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowAddModal(true)}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-2 text-sm"
              >
                <Plus className="h-4 w-4" />
                Add Bank Account
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : accounts.length === 0 ? (
            <div className="text-center py-12">
              <Landmark className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No bank accounts configured</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                Bank accounts are GL accounts with subtype &quot;bank&quot;
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {accounts.map((acct) => (
                <div key={acct.id} className="p-5 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] hover:border-cyan-500/30 transition-colors relative group">
                  <button
                    onClick={() => handleEdit(acct)}
                    className="absolute top-3 right-12 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] hover:text-cyan-400 transition-all"
                    title="Edit account"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-mono text-[var(--ff-text-tertiary)]">{acct.accountCode}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs ${acct.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                      {acct.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">{acct.accountName}</h3>
                  {acct.bankAccountNumber && (
                    <p className="text-xs font-mono text-[var(--ff-text-tertiary)] mt-0.5">
                      Acc: {maskAccountNumber(acct.bankAccountNumber)}
                    </p>
                  )}
                  {acct.description && (
                    <p className="text-sm text-[var(--ff-text-secondary)] mt-1">{acct.description}</p>
                  )}

                  <div className="mt-4 pt-3 border-t border-[var(--ff-border-light)]">
                    <p className="text-sm text-[var(--ff-text-secondary)]">Net Balance</p>
                    <p className={`text-2xl font-bold ${acct.balance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatCurrency(acct.balance)}
                    </p>
                  </div>

                  <div className="mt-3 flex gap-4 text-sm">
                    <div className="flex items-center gap-1 text-emerald-400">
                      <ArrowDownRight className="h-3.5 w-3.5" />
                      <span>{formatCurrency(acct.totalCredits)}</span>
                    </div>
                    <div className="flex items-center gap-1 text-red-400">
                      <ArrowUpRight className="h-3.5 w-3.5" />
                      <span>{formatCurrency(acct.totalDebits)}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between text-xs text-[var(--ff-text-tertiary)]">
                    <span>{acct.txnCount.toLocaleString()} transactions</span>
                    {acct.firstDate && acct.lastDate && (
                      <span>{acct.firstDate} &rarr; {acct.lastDate}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add Bank Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Add Bank Account</h2>
              <button onClick={() => setShowAddModal(false)} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                  Account Code *
                </label>
                <input
                  type="text"
                  placeholder="e.g. 1114"
                  value={form.accountCode}
                  onChange={e => setForm(f => ({ ...f, accountCode: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                  Account Name *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Bank - FNB Current"
                  value={form.accountName}
                  onChange={e => setForm(f => ({ ...f, accountName: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                  Bank Account Number
                </label>
                <input
                  type="text"
                  placeholder="e.g. 4078012345"
                  value={form.bankAccountNumber}
                  onChange={e => setForm(f => ({ ...f, bankAccountNumber: e.target.value }))}
                  maxLength={50}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-cyan-500"
                />
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Displayed masked (last 4 digits only) for security</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                  Description
                </label>
                <input
                  type="text"
                  placeholder="Optional description"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <p className="text-xs text-[var(--ff-text-tertiary)]">
                Creates a GL account under Current Assets (1100) with subtype &quot;bank&quot;.
              </p>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={saving}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm flex items-center gap-2"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Account
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Bank Account Modal */}
      {editingAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingAccount(null)}>
          <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Edit Bank Account</h2>
                <p className="text-xs font-mono text-[var(--ff-text-tertiary)]">GL Code: {editingAccount.accountCode}</p>
              </div>
              <button onClick={() => setEditingAccount(null)} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                  Account Name *
                </label>
                <input
                  type="text"
                  value={editForm.accountName}
                  onChange={e => setEditForm(f => ({ ...f, accountName: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                  Bank Account Number
                </label>
                <input
                  type="text"
                  placeholder="e.g. 4078012345"
                  value={editForm.bankAccountNumber}
                  onChange={e => setEditForm(f => ({ ...f, bankAccountNumber: e.target.value }))}
                  maxLength={50}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-cyan-500"
                />
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Displayed masked (last 4 digits only) for security</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                  Description
                </label>
                <input
                  type="text"
                  placeholder="Optional description"
                  value={editForm.description}
                  onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setEditingAccount(null)}
                className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded-lg text-sm flex items-center gap-2"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
