/**
 * Chart of Accounts Tab — accounts table with add/edit/delete and sidebar filter
 */

import { useState, useEffect } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  AccountCategorySidebar,
  filterAccounts,
  type AccountCategoryType,
} from '@/components/accounting/AccountCategorySidebar';
import type { GLAccount, GLAccountType } from '@/modules/accounting/types/gl.types';
import { AccountRow } from './AccountRow';

const SUBTYPES_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  asset: [
    { value: 'bank', label: 'Bank' },
    { value: 'receivable', label: 'Receivable' },
    { value: 'inventory', label: 'Inventory' },
    { value: 'fixed_asset', label: 'Fixed Asset' },
    { value: 'accumulated_depreciation', label: 'Accum. Depreciation' },
    { value: 'other_current_asset', label: 'Other Current Asset' },
    { value: 'other', label: 'Other' },
  ],
  liability: [
    { value: 'payable', label: 'Payable' },
    { value: 'tax', label: 'Tax' },
    { value: 'other_current_liability', label: 'Other Current Liability' },
    { value: 'other', label: 'Other' },
  ],
  equity: [
    { value: 'equity', label: 'Equity' },
    { value: 'retained_earnings', label: 'Retained Earnings' },
    { value: 'other', label: 'Other' },
  ],
  revenue: [{ value: 'revenue', label: 'Revenue' }, { value: 'other', label: 'Other' }],
  expense: [
    { value: 'cost_of_sales', label: 'Cost of Sales' },
    { value: 'operating_expense', label: 'Operating Expense' },
    { value: 'other', label: 'Other' },
  ],
};

export function ChartOfAccountsTab() {
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'flat' | 'tree'>('flat');
  const [filterType, setFilterType] = useState<string>('all');
  const [sidebarType, setSidebarType] = useState<AccountCategoryType>('all');
  const [sidebarPrefix, setSidebarPrefix] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [addForm, setAddForm] = useState({
    accountCode: '', accountName: '', accountType: 'asset' as GLAccountType,
    accountSubtype: '', parentAccountId: '', description: '',
  });

  useEffect(() => { loadAccounts(); }, [viewMode, showInactive]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAccounts = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (viewMode === 'tree') params.set('view', 'tree');
      if (showInactive) params.set('includeInactive', 'true');
      const res = await apiFetch(`/api/accounting/chart-of-accounts?${params}`);
      const data = await res.json();
      setAccounts(data.data || data || []);
    } catch (err) {
      log.error('Failed to load accounts', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddAccount = async () => {
    if (!addForm.accountCode || !addForm.accountName) return;
    setIsSaving(true);
    try {
      const normalBalance = (addForm.accountType === 'asset' || addForm.accountType === 'expense') ? 'debit' : 'credit';
      const res = await apiFetch('/api/accounting/chart-of-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...addForm, accountSubtype: addForm.accountSubtype || undefined, parentAccountId: addForm.parentAccountId || undefined, description: addForm.description || undefined, normalBalance }),
      });
      if (!res.ok) { const errData = await res.json(); throw new Error(errData.message || 'Failed to create account'); }
      setShowAddForm(false);
      setAddForm({ accountCode: '', accountName: '', accountType: 'asset', accountSubtype: '', parentAccountId: '', description: '' });
      await loadAccounts();
    } catch (err) {
      log.error('Failed to create account', { error: err }, 'accounting-ui');
      alert(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateAccount = async (id: string, data: { accountName: string; description: string; defaultVatCode: string }) => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id, ...data }) });
      if (!res.ok) { const errData = await res.json(); throw new Error(errData.message || 'Failed to update account'); }
      await loadAccounts();
    } catch (err) {
      log.error('Failed to update account', { error: err }, 'accounting-ui');
      alert(err instanceof Error ? err.message : 'Failed to update account');
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (!window.confirm('Deactivate this account? It will be hidden from the chart of accounts.')) return;
    try {
      const res = await apiFetch(`/api/accounting/chart-of-accounts-detail?id=${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) { const errData = await res.json(); throw new Error(errData.message || 'Failed to delete account'); }
      await loadAccounts();
    } catch (err) {
      log.error('Failed to delete account', { error: err }, 'accounting-ui');
      alert(err instanceof Error ? err.message : 'Failed to delete account');
    }
  };

  const baseFiltered = filterType === 'all' ? accounts : accounts.filter(a => a.accountType === filterType);
  const filteredAccounts = filterAccounts(baseFiltered, sidebarType, sidebarPrefix);
  const subtypes = SUBTYPES_BY_TYPE[addForm.accountType] || [];
  const parentOptions = accounts.filter(a => a.isActive);

  return (
    <div className="flex gap-5">
      <AccountCategorySidebar accounts={accounts} selectedType={sidebarType} searchPrefix={sidebarPrefix} onSelectType={setSidebarType} onSearchPrefixChange={setSidebarPrefix} />
      <div className="flex-1 min-w-0 space-y-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <select value={filterType} onChange={e => setFilterType(e.target.value)} className="ff-select text-sm py-2 px-3 min-w-[160px]">
              <option value="all">All Types</option>
              <option value="asset">Assets</option>
              <option value="liability">Liabilities</option>
              <option value="equity">Equity</option>
              <option value="revenue">Revenue</option>
              <option value="expense">Expenses</option>
            </select>
            <div className="flex rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              {(['flat', 'tree'] as const).map(mode => (
                <button key={mode} onClick={() => setViewMode(mode)} className={`px-3 py-2 text-sm font-medium transition-colors ${viewMode === mode ? 'bg-teal-600 text-white' : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] cursor-pointer select-none">
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="rounded border-[var(--ff-border-light)]" />
              Show inactive
            </label>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-sm text-[var(--ff-text-secondary)]">{filteredAccounts.length} account{filteredAccounts.length !== 1 ? 's' : ''}</p>
            <button onClick={() => setShowAddForm(!showAddForm)} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium">
              <Plus className="h-4 w-4" /> Add Account
            </button>
          </div>
        </div>

        {/* Add Account Form */}
        {showAddForm && (
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-teal-500/30 p-4 space-y-4">
            <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">New Account</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Code *</label>
                <input type="text" value={addForm.accountCode} onChange={e => setAddForm(f => ({ ...f, accountCode: e.target.value }))} placeholder="e.g. 1100" className="ff-input w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Name *</label>
                <input type="text" value={addForm.accountName} onChange={e => setAddForm(f => ({ ...f, accountName: e.target.value }))} placeholder="e.g. Accounts Receivable" className="ff-input w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Type *</label>
                <select value={addForm.accountType} onChange={e => setAddForm(f => ({ ...f, accountType: e.target.value as GLAccountType, accountSubtype: '' }))} className="ff-select w-full text-sm">
                  <option value="asset">Asset</option>
                  <option value="liability">Liability</option>
                  <option value="equity">Equity</option>
                  <option value="revenue">Revenue</option>
                  <option value="expense">Expense</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Subtype</label>
                <select value={addForm.accountSubtype} onChange={e => setAddForm(f => ({ ...f, accountSubtype: e.target.value }))} className="ff-select w-full text-sm">
                  <option value="">None</option>
                  {subtypes.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Parent Account</label>
                <select value={addForm.parentAccountId} onChange={e => setAddForm(f => ({ ...f, parentAccountId: e.target.value }))} className="ff-select w-full text-sm">
                  <option value="">None (top-level)</option>
                  {parentOptions.map(a => <option key={a.id} value={a.id}>{a.accountCode} - {a.accountName}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Description</label>
                <input type="text" value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional description" className="ff-input w-full text-sm" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Normal balance: <span className="font-medium">{addForm.accountType === 'asset' || addForm.accountType === 'expense' ? 'Debit' : 'Credit'}</span> (auto-set from type)</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowAddForm(false)} className="px-3 py-2 text-sm font-medium text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">Cancel</button>
                <button onClick={handleAddAccount} disabled={isSaving || !addForm.accountCode || !addForm.accountName} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium disabled:opacity-50">
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {isSaving ? 'Creating...' : 'Create Account'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Accounts Table */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                    {['Code', 'Account Name', 'Type', 'Normal Balance', 'VAT Default', 'System', 'Actions'].map((h, i) => (
                      <th key={h} className={`px-6 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] ${i === 5 ? 'text-center' : i === 6 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map(account => (
                    <AccountRow key={account.id} account={account} level={0} viewMode={viewMode} onUpdate={handleUpdateAccount} onDelete={handleDeleteAccount} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
