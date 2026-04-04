/**
 * AccountRow — inline-editable row for the Chart of Accounts table
 */

import { useState } from 'react';
import { Loader2, Pencil, Trash2, Save, X, Lock } from 'lucide-react';
import type { GLAccount } from '@/modules/accounting/types/gl.types';

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
  account, level, viewMode, onUpdate, onDelete,
}: {
  account: GLAccount;
  level: number;
  viewMode: string;
  onUpdate: (id: string, data: { accountName: string; description: string; defaultVatCode: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.accountName);
  const [editDesc, setEditDesc] = useState(account.description || '');
  const [editVatCode, setEditVatCode] = useState<string>(account.defaultVatCode || 'none');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    await onUpdate(account.id, { accountName: editName, description: editDesc, defaultVatCode: editVatCode });
    setIsSaving(false);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditName(account.accountName);
    setEditDesc(account.description || '');
    setEditVatCode(account.defaultVatCode || 'none');
    setIsEditing(false);
  };

  const indent = viewMode === 'tree' ? `${level * 1.5}rem` : '0';

  return (
    <>
      <tr className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors ${!account.isActive ? 'opacity-50' : ''}`}>
        <td className="px-6 py-3 text-sm font-mono font-medium text-[var(--ff-text-primary)]">
          <span style={{ paddingLeft: indent }}>{account.accountCode}</span>
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
            </div>
          ) : (
            <div style={{ paddingLeft: indent }}>
              <span>{account.accountName}</span>
              {!account.isActive && <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-500/20 text-gray-400">Inactive</span>}
              {account.description && <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{account.description}</p>}
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
        <AccountRow key={child.id} account={child} level={level + 1} viewMode={viewMode} onUpdate={onUpdate} onDelete={onDelete} />
      ))}
    </>
  );
}
