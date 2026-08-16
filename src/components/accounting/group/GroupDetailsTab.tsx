/**
 * Group Details Tab — create/edit group and manage member companies
 */

import { useState } from 'react';
import { Plus, Loader2, Save } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  CompanyGroup, GroupMember, SimpleCompany,
  INPUT_CLS, LABEL_CLS, BTN_PRIMARY, SECTION_CLS,
  MONTHS,
} from './types';
import { GroupMembersSection } from './GroupMembersSection';
import { createGroupBody, updateGroupBody } from './groupRequests';

interface Props {
  group: CompanyGroup | null;
  members: GroupMember[];
  userCompanies: SimpleCompany[];
  onGroupChange: (g: CompanyGroup) => void;
  onMembersRefresh: () => Promise<void>;
  onGroupRefresh: () => Promise<void>;
  onFlash: (msg: string, type: 'success' | 'error') => void;
}

export function GroupDetailsTab({
  group, members, userCompanies,
  onGroupChange, onMembersRefresh, onGroupRefresh, onFlash,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '', holdingCompanyId: '', defaultCurrency: 'ZAR', financialYearStart: 3,
  });

  const memberCompanyIds = new Set(members.map(m => m.companyId));
  const availableCompanies = userCompanies.filter(c => !memberCompanyIds.has(c.id));

  const handleCreateGroup = async () => {
    if (!createForm.name.trim()) { onFlash('Group name is required', 'error'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createGroupBody(createForm)),
      });
      if (!res.ok) throw new Error('Create failed');
      onFlash('Group created', 'success');
      await onGroupRefresh();
    } catch (e) {
      log.error('Group details operation failed', { error: e }, 'group');
      onFlash('Failed to create group', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateGroup = async () => {
    if (!group) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateGroupBody(group.id, {
          name: group.name,
          holdingCompanyId: group.holdingCompanyId,
          defaultCurrency: group.defaultCurrency,
          financialYearStart: group.financialYearStart,
        })),
      });
      if (!res.ok) throw new Error('Update failed');
      onFlash('Group updated', 'success');
    } catch (e) {
      log.error('Group details operation failed', { error: e }, 'group');
      onFlash('Failed to update group', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!group) {
    return (
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Create Group</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={LABEL_CLS}>Group Name *</label>
            <input
              className={INPUT_CLS}
              value={createForm.name}
              onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
              placeholder="e.g. Acme Holdings Group"
            />
          </div>
          <div>
            <label className={LABEL_CLS}>Holding Company</label>
            <select
              className={INPUT_CLS}
              value={createForm.holdingCompanyId}
              onChange={e => setCreateForm({ ...createForm, holdingCompanyId: e.target.value })}
            >
              <option value="">-- Select --</option>
              {userCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS}>Default Currency</label>
            <input
              className={INPUT_CLS}
              value={createForm.defaultCurrency}
              onChange={e => setCreateForm({ ...createForm, defaultCurrency: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL_CLS}>Financial Year Start</label>
            <select
              className={INPUT_CLS}
              value={createForm.financialYearStart}
              onChange={e => setCreateForm({ ...createForm, financialYearStart: Number(e.target.value) })}
            >
              {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-6">
          <button onClick={() => void handleCreateGroup()} disabled={saving} className={BTN_PRIMARY}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create Group
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className={SECTION_CLS}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Group Details</h2>
          <button onClick={() => void handleUpdateGroup()} disabled={saving} className={BTN_PRIMARY}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={LABEL_CLS}>Group Name *</label>
            <input className={INPUT_CLS} value={group.name} onChange={e => onGroupChange({ ...group, name: e.target.value })} />
          </div>
          <div>
            <label className={LABEL_CLS}>Holding Company</label>
            <select
              className={INPUT_CLS}
              value={group.holdingCompanyId ?? ''}
              onChange={e => onGroupChange({ ...group, holdingCompanyId: e.target.value || null })}
            >
              <option value="">-- None --</option>
              {userCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS}>Default Currency</label>
            <input className={INPUT_CLS} value={group.defaultCurrency} onChange={e => onGroupChange({ ...group, defaultCurrency: e.target.value })} />
          </div>
          <div>
            <label className={LABEL_CLS}>Financial Year Start</label>
            <select
              className={INPUT_CLS}
              value={group.financialYearStart}
              onChange={e => onGroupChange({ ...group, financialYearStart: Number(e.target.value) })}
            >
              {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
          </div>
        </div>
      </section>

      <GroupMembersSection
        group={group}
        members={members}
        availableCompanies={availableCompanies}
        onRefresh={onMembersRefresh}
        onFlash={onFlash}
      />
    </div>
  );
}
