/**
 * Group COA Tab — manage the group chart of accounts
 */

import { useState } from 'react';
import { Plus, Loader2, Save, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  CompanyGroup, GroupAccount, SimpleCompany,
  INPUT_CLS, LABEL_CLS, BTN_PRIMARY, BTN_SECONDARY, SECTION_CLS,
} from './types';

interface Props {
  group: CompanyGroup | null;
  groupAccounts: GroupAccount[];
  userCompanies: SimpleCompany[];
  loading: boolean;
  onAccountsRefresh: () => Promise<void>;
  onFlash: (msg: string, type: 'success' | 'error') => void;
}

export function GroupCoaTab({
  group, groupAccounts, userCompanies, loading, onAccountsRefresh, onFlash,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [coaSourceCompany, setCoaSourceCompany] = useState('');
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editAccountName, setEditAccountName] = useState('');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [newAccount, setNewAccount] = useState({
    code: '', name: '', account_type: 'asset', sub_type: '', level: 1,
  });

  if (!group) {
    return (
      <p className="text-sm text-[var(--ff-text-secondary)] text-center py-8">Create a group first</p>
    );
  }

  const handleAutoGenerateCoa = async () => {
    if (!coaSourceCompany) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto-generate-coa', group_id: group.id, source_company_id: coaSourceCompany }),
      });
      if (!res.ok) throw new Error('Auto-generate failed');
      onFlash('Group COA generated from company', 'success');
      setCoaSourceCompany('');
      await onAccountsRefresh();
    } catch {
      onFlash('Failed to generate group COA', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleAddGroupAccount = async () => {
    if (!newAccount.code.trim() || !newAccount.name.trim()) {
      onFlash('Code and name are required', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-account', group_id: group.id, ...newAccount }),
      });
      if (!res.ok) throw new Error('Add account failed');
      onFlash('Account added', 'success');
      setShowAddAccount(false);
      setNewAccount({ code: '', name: '', account_type: 'asset', sub_type: '', level: 1 });
      await onAccountsRefresh();
    } catch {
      onFlash('Failed to add account', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAccountName = async (accountId: string) => {
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-account', account_id: accountId, name: editAccountName }),
      });
      if (!res.ok) throw new Error('Update failed');
      setEditingAccountId(null);
      await onAccountsRefresh();
    } catch {
      onFlash('Failed to update account name', 'error');
    }
  };

  return (
    <section className={SECTION_CLS}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Group Chart of Accounts</h2>
        <button onClick={() => setShowAddAccount(true)} className={BTN_SECONDARY}>
          <Plus className="h-4 w-4" /> Add Account
        </button>
      </div>

      {/* Auto-generate from company */}
      <div className="mb-4 p-4 bg-[var(--ff-bg-primary)] rounded-lg border border-[var(--ff-border-primary)] flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className={LABEL_CLS}>Auto-Generate from Company</label>
          <select
            className={INPUT_CLS}
            value={coaSourceCompany}
            onChange={e => setCoaSourceCompany(e.target.value)}
          >
            <option value="">-- Select source company --</option>
            {userCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <button
          onClick={() => void handleAutoGenerateCoa()}
          disabled={saving || !coaSourceCompany}
          className={BTN_PRIMARY}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Generate
        </button>
      </div>

      {/* Add account inline */}
      {showAddAccount && (
        <div className="mb-4 p-4 bg-[var(--ff-bg-primary)] rounded-lg border border-[var(--ff-border-primary)] space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <label className={LABEL_CLS}>Code *</label>
              <input className={INPUT_CLS} value={newAccount.code} onChange={e => setNewAccount({ ...newAccount, code: e.target.value })} />
            </div>
            <div>
              <label className={LABEL_CLS}>Name *</label>
              <input className={INPUT_CLS} value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} />
            </div>
            <div>
              <label className={LABEL_CLS}>Type</label>
              <select className={INPUT_CLS} value={newAccount.account_type} onChange={e => setNewAccount({ ...newAccount, account_type: e.target.value })}>
                <option value="asset">Asset</option>
                <option value="liability">Liability</option>
                <option value="equity">Equity</option>
                <option value="revenue">Revenue</option>
                <option value="expense">Expense</option>
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Sub-type</label>
              <input className={INPUT_CLS} value={newAccount.sub_type} onChange={e => setNewAccount({ ...newAccount, sub_type: e.target.value })} />
            </div>
            <div>
              <label className={LABEL_CLS}>Level</label>
              <input type="number" min={1} max={9} className={INPUT_CLS} value={newAccount.level}
                onChange={e => setNewAccount({ ...newAccount, level: Number(e.target.value) })} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void handleAddGroupAccount()} disabled={saving} className={BTN_PRIMARY}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
            </button>
            <button onClick={() => setShowAddAccount(false)} className={BTN_SECONDARY}>Cancel</button>
          </div>
        </div>
      )}

      {/* COA Table */}
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
      ) : groupAccounts.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-tertiary)] py-8 text-center">
          No group accounts yet. Auto-generate from a company or add manually.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-primary)]">
                <th className="pb-2 font-medium">Code</th>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Type</th>
                <th className="pb-2 font-medium">Sub-type</th>
                <th className="pb-2 font-medium">Level</th>
              </tr>
            </thead>
            <tbody>
              {groupAccounts.map(a => (
                <tr key={a.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                  <td className="py-2 text-[var(--ff-text-primary)] font-mono text-xs">{a.code}</td>
                  <td className="py-2 text-[var(--ff-text-primary)]">
                    {editingAccountId === a.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          className={INPUT_CLS + ' flex-1'}
                          value={editAccountName}
                          onChange={e => setEditAccountName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') void handleSaveAccountName(a.id);
                            if (e.key === 'Escape') setEditingAccountId(null);
                          }}
                        />
                        <button onClick={() => void handleSaveAccountName(a.id)}
                          className="p-1 rounded hover:bg-teal-500/10 text-teal-500" title="Save">
                          <Save className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span
                        className="cursor-pointer hover:text-teal-400 transition-colors"
                        style={{ paddingLeft: `${(a.level - 1) * 16}px` }}
                        onClick={() => { setEditingAccountId(a.id); setEditAccountName(a.name); }}
                        title="Click to edit"
                      >
                        {a.name}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-[var(--ff-text-secondary)] capitalize">{a.account_type}</td>
                  <td className="py-2 text-[var(--ff-text-tertiary)]">{a.sub_type || '-'}</td>
                  <td className="py-2 text-[var(--ff-text-tertiary)]">{a.level}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
