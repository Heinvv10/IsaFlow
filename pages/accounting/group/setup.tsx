/**
 * Group Setup / Management — Create groups, manage members, COA mapping
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Building2, Plus, Loader2, AlertCircle, CheckCircle2, Save,
  Trash2, Pencil, RefreshCw, Link2, Layers, Users, BookOpen,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CompanyGroup {
  id: string;
  name: string;
  holding_company_id: string | null;
  default_currency: string;
  financial_year_start: number;
  created_at: string;
}

interface GroupMember {
  id: string;
  company_id: string;
  company_name: string;
  ownership_pct: number;
  consolidation_method: 'full' | 'proportionate' | 'equity';
  joined_at: string;
}

interface GroupAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
  sub_type: string | null;
  level: number;
}

interface AccountMapping {
  company_account_id: string;
  company_account_code: string;
  company_account_name: string;
  group_account_id: string | null;
  group_account_code: string | null;
  group_account_name: string | null;
}

interface SimpleCompany {
  id: string;
  name: string;
}

type Tab = 'details' | 'coa' | 'mapping';

/* ------------------------------------------------------------------ */
/*  Shared classes                                                     */
/* ------------------------------------------------------------------ */

const INPUT_CLS =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 outline-none';
const LABEL_CLS = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';
const BTN_PRIMARY =
  'flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50';
const BTN_SECONDARY =
  'flex items-center gap-2 px-3 py-1.5 border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg text-sm transition-colors disabled:opacity-50';
const SECTION_CLS =
  'bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CONSOLIDATION_METHODS = [
  { value: 'full', label: 'Full Consolidation' },
  { value: 'proportionate', label: 'Proportionate' },
  { value: 'equity', label: 'Equity Method' },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function GroupSetupPage() {
  const [activeTab, setActiveTab] = useState<Tab>('details');

  // Global state
  const [group, setGroup] = useState<CompanyGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [userCompanies, setUserCompanies] = useState<SimpleCompany[]>([]);

  // Tab 1 — details & members
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMember, setNewMember] = useState<{ company_id: string; ownership_pct: number; consolidation_method: string }>({ company_id: '', ownership_pct: 100, consolidation_method: 'full' });
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editMember, setEditMember] = useState<{ ownership_pct: number; consolidation_method: string }>({ ownership_pct: 100, consolidation_method: 'full' });

  // Create form (when no group exists)
  const [createForm, setCreateForm] = useState({
    name: '',
    holding_company_id: '',
    default_currency: 'ZAR',
    financial_year_start: 3,
  });

  // Tab 2 — group COA
  const [groupAccounts, setGroupAccounts] = useState<GroupAccount[]>([]);
  const [loadingCoa, setLoadingCoa] = useState(false);
  const [coaSourceCompany, setCoaSourceCompany] = useState('');
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editAccountName, setEditAccountName] = useState('');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [newAccount, setNewAccount] = useState({ code: '', name: '', account_type: 'asset', sub_type: '', level: 1 });

  // Tab 3 — COA mapping
  const [mappingCompanyId, setMappingCompanyId] = useState('');
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [loadingMappings, setLoadingMappings] = useState(false);
  const [autoMapping, setAutoMapping] = useState(false);

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const flash = useCallback((msg: string, type: 'success' | 'error') => {
    if (type === 'success') {
      setSuccess(msg);
      setError('');
      setTimeout(() => setSuccess(''), 3000);
    } else {
      setError(msg);
      setSuccess('');
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Data fetching                                                    */
  /* ---------------------------------------------------------------- */

  const fetchGroup = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups');
      const json = await res.json();
      const groups: CompanyGroup[] = json.data?.items ?? json.data ?? [];
      if (groups.length > 0) {
        setGroup(groups[0] ?? null);
      } else {
        setGroup(null);
      }
    } catch {
      flash('Failed to load group', 'error');
    } finally {
      setLoading(false);
    }
  }, [flash]);

  const fetchUserCompanies = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/companies?action=user-companies');
      const json = await res.json();
      setUserCompanies(json.data?.items ?? json.data ?? []);
    } catch {
      // Non-critical
    }
  }, []);

  const fetchMembers = useCallback(async (groupId: string) => {
    try {
      const res = await apiFetch(`/api/accounting/company-groups?action=members&group_id=${groupId}`);
      const json = await res.json();
      setMembers(json.data?.items ?? json.data ?? []);
    } catch {
      flash('Failed to load members', 'error');
    }
  }, [flash]);

  const fetchGroupAccounts = useCallback(async (groupId: string) => {
    setLoadingCoa(true);
    try {
      const res = await apiFetch(`/api/accounting/company-groups?action=accounts&group_id=${groupId}`);
      const json = await res.json();
      setGroupAccounts(json.data?.items ?? json.data ?? []);
    } catch {
      flash('Failed to load group chart of accounts', 'error');
    } finally {
      setLoadingCoa(false);
    }
  }, [flash]);

  const fetchMappings = useCallback(async (groupId: string, companyId: string) => {
    setLoadingMappings(true);
    try {
      const res = await apiFetch(
        `/api/accounting/company-groups?action=mappings&group_id=${groupId}&company_id=${companyId}`,
      );
      const json = await res.json();
      setMappings(json.data?.items ?? json.data ?? []);
    } catch {
      flash('Failed to load mappings', 'error');
    } finally {
      setLoadingMappings(false);
    }
  }, [flash]);

  /* ---------------------------------------------------------------- */
  /*  Effects                                                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    void fetchGroup();
    void fetchUserCompanies();
  }, [fetchGroup, fetchUserCompanies]);

  useEffect(() => {
    if (group?.id) void fetchMembers(group.id);
  }, [group?.id, fetchMembers]);

  useEffect(() => {
    if (group?.id && activeTab === 'coa') void fetchGroupAccounts(group.id);
  }, [group?.id, activeTab, fetchGroupAccounts]);

  useEffect(() => {
    if (group?.id && mappingCompanyId && activeTab === 'mapping') {
      void fetchMappings(group.id, mappingCompanyId);
    }
  }, [group?.id, mappingCompanyId, activeTab, fetchMappings]);

  /* ---------------------------------------------------------------- */
  /*  Actions — Group CRUD                                             */
  /* ---------------------------------------------------------------- */

  const handleCreateGroup = async () => {
    if (!createForm.name.trim()) { flash('Group name is required', 'error'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createForm),
      });
      if (!res.ok) throw new Error('Create failed');
      flash('Group created', 'success');
      await fetchGroup();
    } catch {
      flash('Failed to create group', 'error');
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
        body: JSON.stringify(group),
      });
      if (!res.ok) throw new Error('Update failed');
      flash('Group updated', 'success');
    } catch {
      flash('Failed to update group', 'error');
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Actions — Members                                                */
  /* ---------------------------------------------------------------- */

  const handleAddMember = async () => {
    if (!group || !newMember.company_id) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-member', group_id: group.id, ...newMember }),
      });
      if (!res.ok) throw new Error('Add member failed');
      flash('Member added', 'success');
      setShowAddMember(false);
      setNewMember({ company_id: '', ownership_pct: 100, consolidation_method: 'full' });
      await fetchMembers(group.id);
    } catch {
      flash('Failed to add member', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateMember = async (memberId: string) => {
    if (!group) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-member', member_id: memberId, ...editMember }),
      });
      if (!res.ok) throw new Error('Update failed');
      flash('Member updated', 'success');
      setEditingMemberId(null);
      await fetchMembers(group.id);
    } catch {
      flash('Failed to update member', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!group || !confirm('Remove this member from the group?')) return;
    try {
      const res = await apiFetch(
        `/api/accounting/company-groups?action=remove-member&member_id=${memberId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error('Remove failed');
      flash('Member removed', 'success');
      await fetchMembers(group.id);
    } catch {
      flash('Failed to remove member', 'error');
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Actions — Group COA                                              */
  /* ---------------------------------------------------------------- */

  const handleAutoGenerateCoa = async () => {
    if (!group || !coaSourceCompany) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto-generate-coa', group_id: group.id, source_company_id: coaSourceCompany }),
      });
      if (!res.ok) throw new Error('Auto-generate failed');
      flash('Group COA generated from company', 'success');
      setCoaSourceCompany('');
      await fetchGroupAccounts(group.id);
    } catch {
      flash('Failed to generate group COA', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleAddGroupAccount = async () => {
    if (!group || !newAccount.code.trim() || !newAccount.name.trim()) {
      flash('Code and name are required', 'error');
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
      flash('Account added', 'success');
      setShowAddAccount(false);
      setNewAccount({ code: '', name: '', account_type: 'asset', sub_type: '', level: 1 });
      await fetchGroupAccounts(group.id);
    } catch {
      flash('Failed to add account', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAccountName = async (accountId: string) => {
    if (!group) return;
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-account', account_id: accountId, name: editAccountName }),
      });
      if (!res.ok) throw new Error('Update failed');
      setEditingAccountId(null);
      await fetchGroupAccounts(group.id);
    } catch {
      flash('Failed to update account name', 'error');
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Actions — COA Mapping                                            */
  /* ---------------------------------------------------------------- */

  const handleSetMapping = async (companyAccountId: string, groupAccountId: string) => {
    if (!group || !mappingCompanyId) return;
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set-mapping',
          group_id: group.id,
          company_id: mappingCompanyId,
          company_account_id: companyAccountId,
          group_account_id: groupAccountId || null,
        }),
      });
      if (!res.ok) throw new Error('Mapping failed');
      await fetchMappings(group.id, mappingCompanyId);
    } catch {
      flash('Failed to set mapping', 'error');
    }
  };

  const handleAutoMap = async () => {
    if (!group || !mappingCompanyId) return;
    setAutoMapping(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto-map', group_id: group.id, company_id: mappingCompanyId }),
      });
      if (!res.ok) throw new Error('Auto-map failed');
      flash('Auto-mapping complete', 'success');
      await fetchMappings(group.id, mappingCompanyId);
    } catch {
      flash('Failed to auto-map accounts', 'error');
    } finally {
      setAutoMapping(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Derived                                                          */
  /* ---------------------------------------------------------------- */

  const memberCompanyIds = new Set(members.map(m => m.company_id));
  const availableCompanies = userCompanies.filter(c => !memberCompanyIds.has(c.id));
  const mappedCount = mappings.filter(m => m.group_account_id).length;
  const totalMappings = mappings.length;

  /* ---------------------------------------------------------------- */
  /*  Tabs config                                                      */
  /* ---------------------------------------------------------------- */

  const tabs: { key: Tab; label: string; icon: typeof Layers }[] = [
    { key: 'details', label: 'Group Details', icon: Users },
    { key: 'coa', label: 'Group Chart of Accounts', icon: BookOpen },
    { key: 'mapping', label: 'COA Mapping', icon: Link2 },
  ];

  /* ---------------------------------------------------------------- */
  /*  Render helpers                                                   */
  /* ---------------------------------------------------------------- */

  const renderAlerts = () => (
    <>
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-500 text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="bg-teal-500/10 border border-teal-500/30 rounded-lg p-3 flex items-center gap-2 text-teal-500 text-sm">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> {success}
        </div>
      )}
    </>
  );

  /* ---------------------------------------------------------------- */
  /*  Tab 1: Group Details                                             */
  /* ---------------------------------------------------------------- */

  const renderDetailsTab = () => {
    if (!group) {
      // --- Create Group form ---
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
                value={createForm.holding_company_id}
                onChange={e => setCreateForm({ ...createForm, holding_company_id: e.target.value })}
              >
                <option value="">-- Select --</option>
                {userCompanies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Default Currency</label>
              <input
                className={INPUT_CLS}
                value={createForm.default_currency}
                onChange={e => setCreateForm({ ...createForm, default_currency: e.target.value })}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Financial Year Start</label>
              <select
                className={INPUT_CLS}
                value={createForm.financial_year_start}
                onChange={e => setCreateForm({ ...createForm, financial_year_start: Number(e.target.value) })}
              >
                {MONTHS.map((m, i) => (
                  <option key={i + 1} value={i + 1}>{m}</option>
                ))}
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

    // --- Edit Group + Members ---
    return (
      <div className="space-y-6">
        {/* Edit Group */}
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
              <input
                className={INPUT_CLS}
                value={group.name}
                onChange={e => setGroup({ ...group, name: e.target.value })}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Holding Company</label>
              <select
                className={INPUT_CLS}
                value={group.holding_company_id ?? ''}
                onChange={e => setGroup({ ...group, holding_company_id: e.target.value || null })}
              >
                <option value="">-- None --</option>
                {userCompanies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Default Currency</label>
              <input
                className={INPUT_CLS}
                value={group.default_currency}
                onChange={e => setGroup({ ...group, default_currency: e.target.value })}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Financial Year Start</label>
              <select
                className={INPUT_CLS}
                value={group.financial_year_start}
                onChange={e => setGroup({ ...group, financial_year_start: Number(e.target.value) })}
              >
                {MONTHS.map((m, i) => (
                  <option key={i + 1} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Members */}
        <section className={SECTION_CLS}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Member Companies</h2>
            <button onClick={() => setShowAddMember(true)} className={BTN_SECONDARY}>
              <Plus className="h-4 w-4" /> Add Member
            </button>
          </div>

          {/* Add member inline form */}
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
                    {availableCompanies.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={LABEL_CLS}>Ownership %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className={INPUT_CLS}
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
                    {CONSOLIDATION_METHODS.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => void handleAddMember()} disabled={saving || !newMember.company_id} className={BTN_PRIMARY}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add
                </button>
                <button onClick={() => setShowAddMember(false)} className={BTN_SECONDARY}>Cancel</button>
              </div>
            </div>
          )}

          {/* Members table */}
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
                          <input
                            type="number"
                            min={0}
                            max={100}
                            className={INPUT_CLS + ' w-20'}
                            value={editMember.ownership_pct}
                            onChange={e => setEditMember({ ...editMember, ownership_pct: Number(e.target.value) })}
                          />
                        ) : (
                          `${m.ownership_pct}%`
                        )}
                      </td>
                      <td className="py-3 text-[var(--ff-text-secondary)]">
                        {editingMemberId === m.id ? (
                          <select
                            className={INPUT_CLS + ' w-40'}
                            value={editMember.consolidation_method}
                            onChange={e => setEditMember({ ...editMember, consolidation_method: e.target.value as 'full' | 'proportionate' | 'equity' })}
                          >
                            {CONSOLIDATION_METHODS.map(cm => (
                              <option key={cm.value} value={cm.value}>{cm.label}</option>
                            ))}
                          </select>
                        ) : (
                          CONSOLIDATION_METHODS.find(cm => cm.value === m.consolidation_method)?.label ?? m.consolidation_method
                        )}
                      </td>
                      <td className="py-3 text-[var(--ff-text-tertiary)]">
                        {new Date(m.joined_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 text-right">
                        {editingMemberId === m.id ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => void handleUpdateMember(m.id)}
                              disabled={saving}
                              className="p-1.5 rounded hover:bg-teal-500/10 text-teal-500"
                              title="Save"
                            >
                              <Save className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => setEditingMemberId(null)}
                              className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]"
                              title="Cancel"
                            >
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
                              className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
                              title="Edit"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => void handleRemoveMember(m.id)}
                              className="p-1.5 rounded hover:bg-red-500/10 text-red-400"
                              title="Remove"
                            >
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
      </div>
    );
  };

  /* ---------------------------------------------------------------- */
  /*  Tab 2: Group COA                                                 */
  /* ---------------------------------------------------------------- */

  const renderCoaTab = () => {
    if (!group) return <p className="text-sm text-[var(--ff-text-secondary)] text-center py-8">Create a group first</p>;

    return (
      <section className={SECTION_CLS}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Group Chart of Accounts</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowAddAccount(true)} className={BTN_SECONDARY}>
              <Plus className="h-4 w-4" /> Add Account
            </button>
          </div>
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
              {userCompanies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
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
                <input type="number" min={1} max={9} className={INPUT_CLS} value={newAccount.level} onChange={e => setNewAccount({ ...newAccount, level: Number(e.target.value) })} />
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
        {loadingCoa ? (
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
                            onKeyDown={e => { if (e.key === 'Enter') void handleSaveAccountName(a.id); if (e.key === 'Escape') setEditingAccountId(null); }}
                          />
                          <button onClick={() => void handleSaveAccountName(a.id)} className="p-1 rounded hover:bg-teal-500/10 text-teal-500" title="Save">
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
  };

  /* ---------------------------------------------------------------- */
  /*  Tab 3: COA Mapping                                               */
  /* ---------------------------------------------------------------- */

  const renderMappingTab = () => {
    if (!group) return <p className="text-sm text-[var(--ff-text-secondary)] text-center py-8">Create a group first</p>;

    return (
      <section className={SECTION_CLS}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">COA Mapping</h2>
          {mappingCompanyId && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--ff-text-tertiary)]">
                {mappedCount} of {totalMappings} accounts mapped
              </span>
              <button onClick={() => void handleAutoMap()} disabled={autoMapping} className={BTN_SECONDARY}>
                {autoMapping ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Auto-Map
              </button>
            </div>
          )}
        </div>

        {/* Company selector */}
        <div className="mb-4">
          <label className={LABEL_CLS}>Select Company</label>
          <select
            className={INPUT_CLS + ' max-w-sm'}
            value={mappingCompanyId}
            onChange={e => setMappingCompanyId(e.target.value)}
          >
            <option value="">-- Select a member company --</option>
            {members.map(m => (
              <option key={m.company_id} value={m.company_id}>{m.company_name}</option>
            ))}
          </select>
        </div>

        {/* Mapping table */}
        {!mappingCompanyId ? (
          <p className="text-sm text-[var(--ff-text-tertiary)] py-8 text-center">Select a company to view and edit mappings</p>
        ) : loadingMappings ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
        ) : mappings.length === 0 ? (
          <p className="text-sm text-[var(--ff-text-tertiary)] py-8 text-center">No accounts found for this company</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-primary)]">
                  <th className="pb-2 font-medium">Company Account</th>
                  <th className="pb-2 font-medium">Group Account</th>
                  <th className="pb-2 font-medium w-28">Status</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map(m => (
                  <tr key={m.company_account_id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                    <td className="py-2 text-[var(--ff-text-primary)]">
                      <span className="font-mono text-xs text-[var(--ff-text-tertiary)] mr-2">{m.company_account_code}</span>
                      {m.company_account_name}
                    </td>
                    <td className="py-2">
                      <select
                        className={INPUT_CLS}
                        value={m.group_account_id ?? ''}
                        onChange={e => void handleSetMapping(m.company_account_id, e.target.value)}
                      >
                        <option value="">-- Unmapped --</option>
                        {groupAccounts.map(ga => (
                          <option key={ga.id} value={ga.id}>
                            {ga.code} — {ga.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2">
                      {m.group_account_id ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-500/10 text-teal-400">
                          Mapped
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400">
                          Unmapped
                        </span>
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
  };

  /* ---------------------------------------------------------------- */
  /*  Main render                                                      */
  /* ---------------------------------------------------------------- */

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-teal-500/10">
            <Layers className="h-6 w-6 text-teal-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Group Setup</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Manage group structure, member companies, and COA consolidation mapping</p>
          </div>
        </div>

        {renderAlerts()}

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-[var(--ff-border-primary)]">
          {tabs.map(t => {
            const Icon = t.icon;
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? 'border-teal-500 text-teal-500'
                    : 'border-transparent text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        ) : (
          <>
            {activeTab === 'details' && renderDetailsTab()}
            {activeTab === 'coa' && renderCoaTab()}
            {activeTab === 'mapping' && renderMappingTab()}
          </>
        )}
      </div>
    </AppLayout>
  );
}
