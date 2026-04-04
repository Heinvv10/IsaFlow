/**
 * Group Setup — thin shell with tab routing and shared data loading
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Layers, Users, BookOpen, Link2, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { GroupDetailsTab } from '@/components/accounting/group/GroupDetailsTab';
import { GroupCoaTab } from '@/components/accounting/group/GroupCoaTab';
import { GroupMappingTab } from '@/components/accounting/group/GroupMappingTab';
import type { CompanyGroup, GroupMember, GroupAccount, AccountMapping, SimpleCompany, GroupSetupTab } from '@/components/accounting/group/types';

const TABS: { key: GroupSetupTab; label: string; icon: typeof Layers }[] = [
  { key: 'details', label: 'Group Details', icon: Users },
  { key: 'coa', label: 'Group Chart of Accounts', icon: BookOpen },
  { key: 'mapping', label: 'COA Mapping', icon: Link2 },
];

export default function GroupSetupPage() {
  const [activeTab, setActiveTab] = useState<GroupSetupTab>('details');
  const [group, setGroup] = useState<CompanyGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [userCompanies, setUserCompanies] = useState<SimpleCompany[]>([]);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [groupAccounts, setGroupAccounts] = useState<GroupAccount[]>([]);
  const [loadingCoa, setLoadingCoa] = useState(false);
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [loadingMappings, setLoadingMappings] = useState(false);
  const [mappingCompanyId, setMappingCompanyId] = useState('');

  /* ------------------------------------------------------------------ */
  /*  Flash helper                                                        */
  /* ------------------------------------------------------------------ */

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

  /* ------------------------------------------------------------------ */
  /*  Data fetchers                                                       */
  /* ------------------------------------------------------------------ */

  const fetchGroup = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups');
      const json = await res.json();
      const groups: CompanyGroup[] = json.data?.items ?? json.data ?? [];
      setGroup(groups[0] ?? null);
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

  /* ------------------------------------------------------------------ */
  /*  Effects                                                             */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    void Promise.all([fetchGroup(), fetchUserCompanies()]);
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

  /* ------------------------------------------------------------------ */
  /*  Handlers passed to tab components                                  */
  /* ------------------------------------------------------------------ */

  const handleMappingCompanyChange = (companyId: string) => {
    setMappingCompanyId(companyId);
    setMappings([]);
  };

  const refreshMappings = async (companyId: string) => {
    if (group?.id) await fetchMappings(group.id, companyId);
  };

  const refreshMembers = async () => {
    if (group?.id) await fetchMembers(group.id);
  };

  const refreshAccounts = async () => {
    if (group?.id) await fetchGroupAccounts(group.id);
  };

  /* ------------------------------------------------------------------ */
  /*  Render                                                              */
  /* ------------------------------------------------------------------ */

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
            <p className="text-sm text-[var(--ff-text-secondary)]">
              Manage group structure, member companies, and COA consolidation mapping
            </p>
          </div>
        </div>

        {/* Alerts */}
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

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-[var(--ff-border-primary)]">
          {TABS.map(t => {
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
            {activeTab === 'details' && (
              <GroupDetailsTab
                group={group}
                members={members}
                userCompanies={userCompanies}
                onGroupChange={setGroup}
                onMembersRefresh={refreshMembers}
                onGroupRefresh={fetchGroup}
                onFlash={flash}
              />
            )}
            {activeTab === 'coa' && (
              <GroupCoaTab
                group={group}
                groupAccounts={groupAccounts}
                userCompanies={userCompanies}
                loading={loadingCoa}
                onAccountsRefresh={refreshAccounts}
                onFlash={flash}
              />
            )}
            {activeTab === 'mapping' && (
              <GroupMappingTab
                group={group}
                members={members}
                groupAccounts={groupAccounts}
                mappings={mappings}
                loading={loadingMappings}
                mappingCompanyId={mappingCompanyId}
                onCompanyChange={handleMappingCompanyChange}
                onMappingsRefresh={refreshMappings}
                onFlash={flash}
              />
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
