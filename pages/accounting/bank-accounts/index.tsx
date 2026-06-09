/**
 * Bank Accounts Management
 * Sage equivalent: Banking > Bank Accounts
 * View and manage bank accounts linked to GL. Sub-accounts (paycards,
 * floats) can be filed under a group umbrella via the Add/Edit modals.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Landmark, Loader2, AlertCircle, Plus } from 'lucide-react';
import { BankEmptyState } from '@/components/accounting/banking/BankEmptyState';
import {
  AddBankAccountModal, EditBankAccountModal, buildParentCandidates,
  type AddForm, type EditForm,
} from '@/components/accounting/bank/BankAccountModals';
import { BankAccountCard, type BankAccountCardData } from '@/components/accounting/bank/BankAccountCard';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';

type BankAccount = BankAccountCardData;

const EMPTY_ADD: AddForm = { accountCode: '', accountName: '', description: '', bankAccountNumber: '', parentAccountId: '' };

export default function BankAccountsPage() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_ADD);

  const [editingAccount, setEditingAccount] = useState<BankAccount | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ accountName: '', description: '', bankAccountNumber: '', parentAccountId: '' });

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/bank-accounts');
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

  const openAddModal = useCallback(async () => {
    setForm(EMPTY_ADD);
    setShowAddModal(true);
    try {
      const qs = new URLSearchParams({ accountType: 'asset', accountSubtype: 'bank' });
      const res = await apiFetch(`/api/accounting/chart-of-accounts-next-code?${qs}`);
      const json = await res.json();
      const code = json?.data?.code ?? json?.code;
      if (code) setForm(f => ({ ...f, accountCode: String(code) }));
    } catch {
      // Suggestion is a convenience — leave blank on failure, user can still type.
    }
  }, []);

  const handleAdd = async () => {
    if (!form.accountCode || !form.accountName) {
      notify.error('Account code and name are required');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          accountCode: form.accountCode,
          accountName: form.accountName,
          accountType: 'asset',
          accountSubtype: 'bank',
          parentAccountId: form.parentAccountId || undefined,
          description: form.description || form.accountName,
          normalBalance: 'debit',
        }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        notify.error(json?.error?.message || 'Failed to create account');
        return;
      }
      // If bank account number provided, save it separately
      if (form.bankAccountNumber.trim()) {
        const created = json.data || json;
        await apiFetch('/api/accounting/bank-accounts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id: created.id, bankAccountNumber: form.bankAccountNumber.trim() }),
        });
      }
      notify.success('Bank account created');
      setShowAddModal(false);
      setForm(EMPTY_ADD);
      loadAccounts();
    } catch {
      notify.error('Failed to create bank account');
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
      parentAccountId: acct.groupId || '',
    });
  };

  const handleSaveEdit = async () => {
    if (!editingAccount) return;
    if (!editForm.accountName.trim()) {
      notify.error('Account name is required');
      return;
    }
    setSaving(true);
    try {
      // Update name & description via chart-of-accounts
      const coaRes = await apiFetch('/api/accounting/chart-of-accounts', {
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
        notify.error(json?.error?.message || 'Failed to update account');
        return;
      }
      // Update bank account number + group assignment
      const bankRes = await apiFetch('/api/accounting/bank-accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: editingAccount.id,
          bankAccountNumber: editForm.bankAccountNumber.trim() || null,
          parentAccountId: editForm.parentAccountId || null,
        }),
      });
      if (!bankRes.ok) {
        const json = await bankRes.json();
        notify.error(json?.error?.message || 'Failed to update bank account');
        return;
      }
      notify.success('Bank account updated');
      setEditingAccount(null);
      loadAccounts();
    } catch {
      notify.error('Failed to update bank account');
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
                onClick={openAddModal}
                className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg flex items-center gap-2 text-sm"
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
            <BankEmptyState context="bank-accounts" onAddBankAccount={openAddModal} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {accounts.map(acct => (
                <BankAccountCard key={acct.id} acct={acct} onEdit={handleEdit} />
              ))}
            </div>
          )}
        </div>
      </div>

      {showAddModal && (
        <AddBankAccountModal
          form={form} setForm={setForm}
          candidates={buildParentCandidates(accounts)}
          saving={saving} onSave={handleAdd} onClose={() => setShowAddModal(false)}
        />
      )}

      {editingAccount && (
        <EditBankAccountModal
          accountCode={editingAccount.accountCode}
          form={editForm} setForm={setEditForm}
          candidates={buildParentCandidates(accounts, editingAccount.id)}
          saving={saving} onSave={handleSaveEdit} onClose={() => setEditingAccount(null)}
        />
      )}
    </AppLayout>
  );
}
