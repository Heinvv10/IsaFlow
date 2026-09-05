/**
 * AccountRow — inline-editable row for the Chart of Accounts table
 */

import { useState } from 'react';
import { Loader2, Pencil, Trash2, Save, X, Lock } from 'lucide-react';
import type { GLAccount } from '@/modules/accounting/types/gl.types';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { subtypeOptionsFor } from './accountSubtypeOptions';

export function accountTypeColor(type: string): string {
  switch (type) {
    case 'asset':     return 'bg-blue-500/20 text-blue-400';
    case 'liability': return 'bg-red-500/20 text-red-400';
    case 'equity':    return 'bg-purple-500/20 text-purple-400';
    case 'revenue':   return 'bg-teal-500/20 text-teal-400';
    case 'expense':   return 'bg-amber-500/20 text-amber-400';
    default:          return 'bg-gray-500/20 text-gray-400';
  }
}

const VAT_LABELS: Record<string, string> = { standard: '15%', zero_rated: 'Zero Rated', exempt: 'Exempt' };

export function AccountRow({
  account, level, viewMode, parentOptions, onUpdate, onDelete, onCodeChanged,
}: {
  account: GLAccount;
  level: number;
  viewMode: string;
  /** Candidate parents — the caller's active-account list, filtered here. */
  parentOptions: GLAccount[];
  onUpdate: (id: string, data: {
    accountName: string;
    description: string;
    defaultVatCode: string;
    vatInputDenied: boolean;
    accountSubtype?: string | null;
    parentAccountId?: string | null;
  }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onCodeChanged?: () => Promise<void> | void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.accountName);
  const [editDesc, setEditDesc] = useState(account.description || '');
  const [editVatCode, setEditVatCode] = useState<string>(account.defaultVatCode || 'none');
  const [editVatDenied, setEditVatDenied] = useState<boolean>(Boolean(account.vatInputDenied));
  const [editSubtype, setEditSubtype] = useState<string>(account.accountSubtype || '');
  const [editParentId, setEditParentId] = useState<string>(account.parentAccountId || '');
  const [isSaving, setIsSaving] = useState(false);

  const [isEditingCode, setIsEditingCode] = useState(false);
  const [editCode, setEditCode] = useState(account.accountCode);
  const [isSavingCode, setIsSavingCode] = useState(false);

  // Code is locked once anything has posted to the account, for system
  // accounts, and when the row is inactive (deactivated accounts are
  // audit-trail only — changing the code would confuse historical reports).
  const codeLocked = account.isSystemAccount || account.hasTransactions === true || !account.isActive;
  const codeLockReason = account.isSystemAccount
    ? 'System account — code is locked'
    : account.hasTransactions
      ? 'Locked — transactions have been posted to this account'
      : !account.isActive
        ? 'Account is inactive'
        : '';

  const handleSave = async () => {
    setIsSaving(true);
    // Send the classification keys ONLY when they actually changed. The API
    // reads `undefined` as "leave alone" and `null` as "clear", and
    // reclassifying runs a separate set of structural guards (cycles, the leaf
    // rule, orphaned bank transactions) that should not fire on a rename.
    const currentSubtype = account.accountSubtype || '';
    const currentParent = account.parentAccountId || '';
    await onUpdate(account.id, {
      accountName: editName, description: editDesc,
      defaultVatCode: editVatCode, vatInputDenied: editVatDenied,
      ...(editSubtype !== currentSubtype ? { accountSubtype: editSubtype || null } : {}),
      ...(editParentId !== currentParent ? { parentAccountId: editParentId || null } : {}),
    });
    setIsSaving(false);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditName(account.accountName);
    setEditDesc(account.description || '');
    setEditVatCode(account.defaultVatCode || 'none');
    setEditVatDenied(Boolean(account.vatInputDenied));
    setEditSubtype(account.accountSubtype || '');
    setEditParentId(account.parentAccountId || '');
    setIsEditing(false);
  };

  const handleSaveCode = async () => {
    const trimmed = editCode.trim();
    if (!trimmed) { notify.error('Account code is required'); return; }
    if (trimmed === account.accountCode) { setIsEditingCode(false); return; }
    setIsSavingCode(true);
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts-detail', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: account.id, accountCode: trimmed }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        notify.error(json?.error?.message || 'Failed to change code');
        return;
      }
      notify.success(`Code changed to ${trimmed}`);
      setIsEditingCode(false);
      await onCodeChanged?.();
    } catch {
      notify.error('Failed to change code');
    } finally {
      setIsSavingCode(false);
    }
  };

  const handleCancelCode = () => {
    setEditCode(account.accountCode);
    setIsEditingCode(false);
  };

  const indent = viewMode === 'tree' ? `${level * 1.5}rem` : '0';

  const subtypeOptions = subtypeOptionsFor(account.accountType);
  // The server refuses a cross-type parent, the account itself, and anything
  // below it in the tree. It cannot know about descendants from this list
  // alone, so this filter is a convenience, not the guard — the API refusal is.
  const eligibleParents = parentOptions.filter(
    a => a.id !== account.id && a.accountType === account.accountType,
  );

  return (
    <>
      <tr className={`group border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors ${!account.isActive ? 'opacity-50' : ''}`}>
        <td className="px-6 py-3 text-sm font-mono font-medium text-[var(--ff-text-primary)]">
          <div className="flex items-center gap-2" style={{ paddingLeft: indent }}>
            {isEditingCode ? (
              <>
                <input
                  type="text"
                  value={editCode}
                  onChange={e => setEditCode(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void handleSaveCode(); if (e.key === 'Escape') handleCancelCode(); }}
                  className="ff-input w-24 text-sm font-mono"
                  autoFocus
                />
                <button onClick={handleSaveCode} disabled={isSavingCode} className="p-1 rounded text-teal-400 hover:bg-teal-500/10 transition-colors disabled:opacity-50" title="Save code">
                  {isSavingCode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                </button>
                <button onClick={handleCancelCode} className="p-1 rounded text-[var(--ff-text-tertiary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors" title="Cancel">
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <>
                <span>{account.accountCode}</span>
                {!codeLocked && (
                  <button
                    onClick={() => { setEditCode(account.accountCode); setIsEditingCode(true); }}
                    className="p-0.5 rounded text-[var(--ff-text-tertiary)] hover:text-blue-400 hover:bg-blue-500/10 transition-all"
                    title="Change code"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
                {codeLocked && account.hasTransactions === true && (
                  <Lock className="h-3 w-3 text-[var(--ff-text-tertiary)]" aria-label={codeLockReason} />
                )}
              </>
            )}
          </div>
        </td>
        <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">
          {isEditing ? (
            <div className="space-y-1" style={{ paddingLeft: indent }}>
              <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className="ff-input w-full text-sm" autoFocus />
              <input type="text" value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Description (optional)" className="ff-input w-full text-xs" />
              <select value={editVatCode} onChange={e => setEditVatCode(e.target.value)} className="ff-select w-full text-xs" title="Default VAT type for transactions posted to this account">
                <option value="none">No VAT (default)</option>
                <option value="standard">Standard 15%</option>
                <option value="zero_rated">Zero Rated</option>
                <option value="exempt">Exempt</option>
              </select>
              {/* Subtype and parent were settable only in the Add Account
                  dialog. An account without subtype = bank cannot receive a
                  statement import at all, and with no edit path the only
                  remedy was to recreate the account under a new code. */}
              <select
                value={editSubtype}
                onChange={e => setEditSubtype(e.target.value)}
                className="ff-select w-full text-xs"
                disabled={account.isSystemAccount}
                title={account.isSystemAccount
                  ? 'System account — auto-posting resolves it by subtype, so the subtype is fixed'
                  : 'Subtype. Bank is what makes an account importable from a statement.'}
              >
                {account.accountType === 'revenue' || account.accountType === 'expense'
                  ? null
                  : <option value="">No subtype</option>}
                {subtypeOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <select
                value={editParentId}
                onChange={e => setEditParentId(e.target.value)}
                className="ff-select w-full text-xs"
                title="Parent account. Only same-type accounts with no postings of their own can be parents."
              >
                <option value="">No parent (top level)</option>
                {eligibleParents.map(a => (
                  <option key={a.id} value={a.id}>{a.accountCode} - {a.accountName}</option>
                ))}
              </select>
              {/* Separate from the default above on purpose: an account can
                  DEFAULT to No VAT and still allow a standard claim (Insurance
                  Expense does). This says the claim itself is denied. */}
              <label className="flex items-start gap-1.5 text-[11px] text-[var(--ff-text-secondary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={editVatDenied}
                  onChange={e => setEditVatDenied(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Input VAT denied (entertainment, s17(2)(a))
                  <span className="block text-[var(--ff-text-tertiary)]">
                    Warns before claiming, and stops bank rules claiming automatically.
                  </span>
                </span>
              </label>
            </div>
          ) : (
            <div style={{ paddingLeft: indent }}>
              <span>{account.accountName}</span>
              {!account.isActive && <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-500/20 text-gray-600 dark:text-gray-400">Inactive</span>}
              {account.description && <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{account.description}</p>}
              {account.vatInputDenied && (
                <span
                  className="mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-700 dark:text-amber-400"
                  title="VAT Act s17(2)(a) — input tax on entertainment is denied. Bank rules will not claim it automatically."
                >
                  Input VAT denied
                </span>
              )}
            </div>
          )}
        </td>
        <td className="px-6 py-3">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase ${accountTypeColor(account.accountType)}`}>{account.accountType}</span>
        </td>
        <td className="px-6 py-3 text-sm text-[var(--ff-text-secondary)] capitalize">{account.normalBalance}</td>
        <td className="px-6 py-3 text-sm">
          {account.defaultVatCode && account.defaultVatCode !== 'none'
            ? <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400">{VAT_LABELS[account.defaultVatCode] ?? account.defaultVatCode}</span>
            : <span className="text-[var(--ff-text-tertiary)] text-xs">—</span>}
        </td>
        <td className="px-6 py-3 text-center">
          {account.isSystemAccount && <Lock className="h-4 w-4 text-[var(--ff-text-tertiary)] mx-auto" />}
        </td>
        <td className="px-6 py-3 text-right">
          {account.isSystemAccount ? null : isEditing ? (
            <div className="flex items-center justify-end gap-1">
              <button onClick={handleSave} disabled={isSaving} className="p-1.5 rounded text-teal-400 hover:bg-teal-500/10 transition-colors disabled:opacity-50" title="Save">
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              </button>
              <button onClick={handleCancel} className="p-1.5 rounded text-[var(--ff-text-tertiary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors" title="Cancel">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-1">
              <button onClick={() => { setIsEditing(true); setEditName(account.accountName); setEditDesc(account.description || ''); }} className="p-1.5 rounded text-[var(--ff-text-tertiary)] hover:text-blue-400 hover:bg-blue-500/10 transition-colors" title="Edit">
                <Pencil className="h-4 w-4" />
              </button>
              <button onClick={() => onDelete(account.id)} className="p-1.5 rounded text-[var(--ff-text-tertiary)] hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Deactivate">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )}
        </td>
      </tr>
      {viewMode === 'tree' && account.children?.map(child => (
        <AccountRow key={child.id} account={child} level={level + 1} viewMode={viewMode} parentOptions={parentOptions} onUpdate={onUpdate} onDelete={onDelete} onCodeChanged={onCodeChanged} />
      ))}
    </>
  );
}
