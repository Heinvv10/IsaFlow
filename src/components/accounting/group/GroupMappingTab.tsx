/**
 * Group COA Mapping Tab — map member company accounts to group accounts
 */

import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  CompanyGroup, GroupMember, GroupAccount, AccountMapping,
  INPUT_CLS, LABEL_CLS, BTN_SECONDARY, SECTION_CLS,
} from './types';

interface Props {
  group: CompanyGroup | null;
  members: GroupMember[];
  groupAccounts: GroupAccount[];
  mappings: AccountMapping[];
  loading: boolean;
  mappingCompanyId: string;
  onCompanyChange: (companyId: string) => void;
  onMappingsRefresh: (companyId: string) => Promise<void>;
  onFlash: (msg: string, type: 'success' | 'error') => void;
}

export function GroupMappingTab({
  group, members, groupAccounts, mappings, loading,
  mappingCompanyId, onCompanyChange, onMappingsRefresh, onFlash,
}: Props) {
  const [autoMapping, setAutoMapping] = useState(false);

  const mappedCount = mappings.filter(m => m.group_account_id).length;
  const totalMappings = mappings.length;

  if (!group) {
    return (
      <p className="text-sm text-[var(--ff-text-secondary)] text-center py-8">Create a group first</p>
    );
  }

  const handleSetMapping = async (companyAccountId: string, groupAccountId: string) => {
    if (!mappingCompanyId) return;
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
      await onMappingsRefresh(mappingCompanyId);
    } catch {
      onFlash('Failed to set mapping', 'error');
    }
  };

  const handleAutoMap = async () => {
    if (!mappingCompanyId) return;
    setAutoMapping(true);
    try {
      const res = await apiFetch('/api/accounting/company-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto-map', group_id: group.id, company_id: mappingCompanyId }),
      });
      if (!res.ok) throw new Error('Auto-map failed');
      onFlash('Auto-mapping complete', 'success');
      await onMappingsRefresh(mappingCompanyId);
    } catch {
      onFlash('Failed to auto-map accounts', 'error');
    } finally {
      setAutoMapping(false);
    }
  };

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
          onChange={e => onCompanyChange(e.target.value)}
        >
          <option value="">-- Select a member company --</option>
          {members.map(m => (
            <option key={m.company_id} value={m.company_id}>{m.company_name}</option>
          ))}
        </select>
      </div>

      {/* Mapping table */}
      {!mappingCompanyId ? (
        <p className="text-sm text-[var(--ff-text-tertiary)] py-8 text-center">
          Select a company to view and edit mappings
        </p>
      ) : loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
      ) : mappings.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-tertiary)] py-8 text-center">
          No accounts found for this company
        </p>
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
                        <option key={ga.id} value={ga.id}>{ga.code} — {ga.name}</option>
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
}
