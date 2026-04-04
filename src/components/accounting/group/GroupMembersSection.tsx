/**
 * Group Members Section — inline within the Group Details tab
 */

import { useState } from 'react';
import { Plus, Loader2, Save, Trash2, Pencil } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  CompanyGroup, GroupMember, SimpleCompany,
  INPUT_CLS, LABEL_CLS, BTN_PRIMARY, BTN_SECONDARY, SECTION_CLS,
  CONSOLIDATION_METHODS,
} from './types';

interface Props {
  group: CompanyGroup;
  members: GroupMember[];
  availableCompanies: SimpleCompany[];
  onRefresh: () => Promise<void>;
  onFlash: (msg: string, type: 'success' | 'error') => void;
}

export function GroupMembersSection({ group, members, availableCompanies, onRefresh, onFlash }: Props) {
  const [saving, setSaving] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMember, setNewMember] = useState({ company_id: '', ownership_pct: 100, consolidation_method: 'full' });
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editMember, setEditMember] = useState({ ownership_pct: 100, consolidation_method: 'full' });

  const handleAddMember = async () => {
    if (!newMember.company_id) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-member', group_id: group.id, ...newMember }),
      });
      if (!res.ok) throw new Error('Add member failed');
      onFlash('Member added', 'success');
      setShowAddMember(false);
      setNewMember({ company_id: '', ownership_pct: 100, consolidation_method: 'full' });
      await onRefresh();
    } catch {
      onFlash('Failed to add member', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateMember = async (memberId: string) => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-member', member_id: memberId, ...editMember }),
      });
      if (!res.ok) throw new Error('Update failed');
      onFlash('Member updated', 'success');
      setEditingMemberId(null);
      await onRefresh();
    } catch {
      onFlash('Failed to update member', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm('Remove this member from the group?')) return;
    try {
      const res = await apiFetch(
        `/api/accounting/company-groups?action=remove-member&member_id=${memberId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error('Remove failed');
      onFlash('Member removed', 'success');
      await onRefresh();
    } catch {
      onFlash('Failed to remove member', 'error');
    }
  };

  return (
    <section className={SECTION_CLS}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Member Companies</h2>
        <button onClick={() => setShowAddMember(true)} className={BTN_SECONDARY}>
          <Plus className="h-4 w-4" /> Add Member
        </button>
      </div>

      {showAddMember && (
        <div className="mb-4 p-4 bg-[var(--ff-bg-primary)] rounded-lg border border-[var(--ff-border-primary)] space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className={LABEL_CLS}>Company *</label>
              <select
                className={INPUT_CLS}
                value={newMember.company_id}
                onChange={e => setNewMember({ ...newMember, company_id: e.target.value })}
              >
                <option value="">-- Select Company --</option>
                {availableCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Ownership %</label>
              <input
                type="number" min={0} max={100} className={INPUT_CLS}
                value={newMember.ownership_pct}
                onChange={e => setNewMember({ ...newMember, ownership_pct: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Consolidation Method</label>
              <select
                className={INPUT_CLS}
                value={newMember.consolidation_method}
                onChange={e => setNewMember({ ...newMember, consolidation_method: e.target.value as 'full' | 'proportionate' | 'equity' })}
              >
                {CONSOLIDATION_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void handleAddMember()} disabled={saving || !newMember.company_id} className={BTN_PRIMARY}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
            </button>
            <button onClick={() => setShowAddMember(false)} className={BTN_SECONDARY}>Cancel</button>
          </div>
        </div>
      )}

      {members.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-tertiary)] py-4 text-center">No member companies yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-primary)]">
                <th className="pb-2 font-medium">Company</th>
                <th className="pb-2 font-medium">Ownership %</th>
                <th className="pb-2 font-medium">Consolidation</th>
                <th className="pb-2 font-medium">Joined</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map(m => (
                <tr key={m.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                  <td className="py-3 text-[var(--ff-text-primary)]">{m.company_name}</td>
                  <td className="py-3 text-[var(--ff-text-secondary)]">
                    {editingMemberId === m.id ? (
                      <input type="number" min={0} max={100} className={INPUT_CLS + ' w-20'}
                        value={editMember.ownership_pct}
                        onChange={e => setEditMember({ ...editMember, ownership_pct: Number(e.target.value) })}
                      />
                    ) : `${m.ownership_pct}%`}
                  </td>
                  <td className="py-3 text-[var(--ff-text-secondary)]">
                    {editingMemberId === m.id ? (
                      <select className={INPUT_CLS + ' w-40'} value={editMember.consolidation_method}
                        onChange={e => setEditMember({ ...editMember, consolidation_method: e.target.value as 'full' | 'proportionate' | 'equity' })}
                      >
                        {CONSOLIDATION_METHODS.map(cm => <option key={cm.value} value={cm.value}>{cm.label}</option>)}
                      </select>
                    ) : (CONSOLIDATION_METHODS.find(cm => cm.value === m.consolidation_method)?.label ?? m.consolidation_method)}
                  </td>
                  <td className="py-3 text-[var(--ff-text-tertiary)]">
                    {new Date(m.joined_at).toLocaleDateString()}
                  </td>
                  <td className="py-3 text-right">
                    {editingMemberId === m.id ? (
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => void handleUpdateMember(m.id)} disabled={saving}
                          className="p-1.5 rounded hover:bg-teal-500/10 text-teal-500" title="Save">
                          <Save className="h-4 w-4" />
                        </button>
                        <button onClick={() => setEditingMemberId(null)}
                          className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => {
                            setEditingMemberId(m.id);
                            setEditMember({ ownership_pct: m.ownership_pct, consolidation_method: m.consolidation_method });
                          }}
                          className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]" title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => void handleRemoveMember(m.id)}
                          className="p-1.5 rounded hover:bg-red-500/10 text-red-400" title="Remove">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
