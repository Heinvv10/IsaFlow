/**
 * Chart of Accounts Tab — accounts table with add/edit/delete and sidebar filter
 */

import { useState, useEffect } from 'react';
import { Plus, Loader2, Search } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  AccountCategorySidebar,
  filterAccounts,
  type AccountCategoryType,
} from '@/components/accounting/AccountCategorySidebar';
import type { GLAccount } from '@/modules/accounting/types/gl.types';
import { AccountRow } from './AccountRow';
import { CoaSeedEmptyState } from './CoaSeedEmptyState';
import { AddAccountForm, type AddAccountFormState } from './AddAccountForm';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { notify } from '@/utils/toast';

function flattenAccounts(nodes: GLAccount[]): GLAccount[] {
  return nodes.flatMap(a => [a, ...(a.children ? flattenAccounts(a.children) : [])]);
}

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
  const [addForm, setAddForm] = useState<AddAccountFormState>({
    accountCode: '', accountName: '', accountType: 'asset',
    accountSubtype: '', parentAccountId: '', description: '',
  });
  // Tracks whether the Code field currently holds a server suggestion. We only
  // overwrite the code when it's either empty or a prior suggestion we placed —
  // never a value the user typed themselves.
  const [suggestedCode, setSuggestedCode] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // The deactivate confirmation used to be window.confirm, which blocks the
  // renderer: nothing on the page can be scripted or driven by a browser agent
  // while it is up, and it cannot be styled or tested. Holding the pending id
  // in state renders an in-page dialog instead — null means no dialog.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => { void loadAccounts(); }, [viewMode, showInactive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showAddForm) return;
    // Don't overwrite user-typed codes.
    if (addForm.accountCode && addForm.accountCode !== suggestedCode) return;

    let cancelled = false;
    void (async () => {
      try {
        const qs = new URLSearchParams({ accountType: addForm.accountType });
        if (addForm.accountSubtype) qs.set('accountSubtype', addForm.accountSubtype);
        if (addForm.parentAccountId) qs.set('parentAccountId', addForm.parentAccountId);
        const res = await apiFetch(`/api/accounting/chart-of-accounts-next-code?${qs}`);
        const json = await res.json();
        const code = json?.data?.code ?? json?.code;
        if (!cancelled && code) {
          setAddForm(f => ({ ...f, accountCode: String(code) }));
          setSuggestedCode(String(code));
        }
      } catch (err) {
        // Suggestion is a convenience — log only, never blocks the form.
        log.error('Failed to load suggested account code', { error: err }, 'accounting-ui');
      }
    })();
    return () => { cancelled = true; };
  }, [showAddForm, addForm.accountType, addForm.accountSubtype, addForm.parentAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setSuggestedCode('');
      await loadAccounts();
    } catch (err) {
      log.error('Failed to create account', { error: err }, 'accounting-ui');
      notify.error(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateAccount = async (
    id: string,
    // accountSubtype / parentAccountId are OPTIONAL and may be null. The API
    // reads `undefined` as "leave alone" and `null` as "clear", so the row
    // editor omits the keys entirely when it did not touch them — spreading a
    // `null` for an untouched field would silently unparent every saved row.
    data: {
      accountName: string;
      description: string;
      defaultVatCode: string;
      vatInputDenied: boolean;
      accountSubtype?: string | null;
      parentAccountId?: string | null;
    },
  ) => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id, ...data }) });
      if (!res.ok) { const errData = await res.json(); throw new Error(errData.message || 'Failed to update account'); }
      await loadAccounts();
    } catch (err) {
      log.error('Failed to update account', { error: err }, 'accounting-ui');
      notify.error(err instanceof Error ? err.message : 'Failed to update account');
    }
  };

  // The row's delete button now only ARMS the dialog. The request itself is
  // confirmDeleteAccount below, so nothing is destroyed by a single click and
  // no blocking native dialog sits between the two.
  const handleDeleteAccount = async (id: string) => { setPendingDeleteId(id); };

  const confirmDeleteAccount = async () => {
    const id = pendingDeleteId;
    if (!id) return;
    setIsDeleting(true);
    try {
      const res = await apiFetch(`/api/accounting/chart-of-accounts-detail?id=${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) { const errData = await res.json(); throw new Error(errData.message || 'Failed to delete account'); }
      setPendingDeleteId(null);
      await loadAccounts();
    } catch (err) {
      log.error('Failed to delete account', { error: err }, 'accounting-ui');
      // The dialog STAYS open on failure. The service refuses for reasons the
      // user can act on (non-zero balance, active children, unreconciled bank
      // transactions), and closing it would hide the reason behind a toast on
      // a row that looks unchanged.
      notify.error(err instanceof Error ? err.message : 'Failed to delete account');
    } finally {
      setIsDeleting(false);
    }
  };

  const baseFiltered = filterType === 'all' ? accounts : accounts.filter(a => a.accountType === filterType);
  const sidebarFiltered = filterAccounts(baseFiltered, sidebarType, sidebarPrefix);
  const q = searchQuery.trim().toLowerCase();
  const filteredAccounts = q
    ? sidebarFiltered.filter(a =>
        a.accountCode.toLowerCase().includes(q) ||
        a.accountName.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q),
      )
    : sidebarFiltered;
  // In tree view `accounts` holds only the roots, with the rest nested under
  // `children` — filtering it directly gave a parent picker containing five
  // options. Flatten first so the candidate list is the same in both views.
  const flatAccounts = flattenAccounts(accounts);
  const parentOptions = flatAccounts.filter(a => a.isActive);

  if (!isLoading && accounts.length === 0) {
    return <CoaSeedEmptyState onSeeded={loadAccounts} />;
  }

  const pendingAccount = pendingDeleteId
    ? flatAccounts.find(a => a.id === pendingDeleteId)
    : undefined;

  return (
    <div className="flex gap-5">
      <AccountCategorySidebar accounts={accounts} selectedType={sidebarType} searchPrefix={sidebarPrefix} onSelectType={setSidebarType} onSearchPrefixChange={setSidebarPrefix} />
      <div className="flex-1 min-w-0 space-y-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)] pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by code or name…"
              className="ff-input pl-9 pr-3 py-2 text-sm w-64"
            />
          </div>
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

        {showAddForm && (
          <AddAccountForm
            addForm={addForm}
            parentOptions={parentOptions}
            isSaving={isSaving}
            onChange={setAddForm}
            onCancel={() => { setShowAddForm(false); setSuggestedCode(''); }}
            onSubmit={handleAddAccount}
          />
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
                    <AccountRow key={account.id} account={account} level={0} viewMode={viewMode} parentOptions={parentOptions} onUpdate={handleUpdateAccount} onDelete={handleDeleteAccount} onCodeChanged={loadAccounts} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Deactivate account"
        message={
          <>
            {pendingAccount
              ? <><strong>{pendingAccount.accountCode} {pendingAccount.accountName}</strong> will be hidden from the chart of accounts.</>
              : 'This account will be hidden from the chart of accounts.'}
            {' '}Nothing is deleted — history and existing postings are kept, and the account
            can be reactivated. It is refused outright if it still has a balance, active child
            accounts, or unreconciled bank transactions.
          </>
        }
        acceptLabel="Deactivate"
        tone="destructive"
        loading={isDeleting}
        onAccept={() => { void confirmDeleteAccount(); }}
        onCancel={() => { if (!isDeleting) setPendingDeleteId(null); }}
      />
    </div>
  );
}
