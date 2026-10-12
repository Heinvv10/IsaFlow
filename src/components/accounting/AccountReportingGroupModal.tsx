/**
 * Account Reporting Group — Create/Edit Modal
 * Dual-list for assigning GL accounts to a group
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, ChevronRight, ChevronLeft, Search, Loader2 } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import type { GLAccount as ChartGLAccount } from '@/modules/accounting/types/gl.types';

interface GlAccount {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface GroupMember {
  gl_account_id: string;
  account_code: string;
  account_name: string;
}

interface AccountReportingGroup {
  id?: string;
  name: string;
  report_type: 'balance_sheet' | 'income_statement' | 'both';
  display_order: number;
  members: GroupMember[];
}

interface Props {
  group: AccountReportingGroup | null;
  onClose: () => void;
  onSaved: () => void;
}

const REPORT_TYPE_LABELS: Record<string, string> = {
  balance_sheet: 'Balance Sheet',
  income_statement: 'Income Statement',
  both: 'Both',
};

export function AccountReportingGroupModal({ group, onClose, onSaved }: Props) {
  const isNew = !group?.id;

  const [name, setName] = useState(group?.name ?? '');
  const [reportType, setReportType] = useState<'balance_sheet' | 'income_statement' | 'both'>(
    group?.report_type ?? 'balance_sheet'
  );
  const [displayOrder, setDisplayOrder] = useState(group?.display_order ?? 0);
  const [allAccounts, setAllAccounts] = useState<GlAccount[]>([]);
  const [memberIds, setMemberIds] = useState<Set<string>>(
    new Set(group?.members.map(m => m.gl_account_id) ?? [])
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts?includeInactive=true');
      await assertOk(res, 'Could not load accounts - try again');
      const json = await res.json();
      // Inactive rows are fetched so a member deactivated since it was added stays visible (and removable);
      // they are never offered as new members (see `available`).
      const rows = Array.isArray(json.data) ? json.data as ChartGLAccount[] : [];
      setAllAccounts(rows.map(a => ({ id: a.id, code: a.accountCode, name: a.accountName, isActive: a.isActive })));
    } catch (err) {
      setAllAccounts([]); setError(apiErrorMessage(err, 'Could not load accounts - try again'));
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  const available = useMemo(() => {
    const q = search.toLowerCase();
    return allAccounts.filter(a =>
      a.isActive && !memberIds.has(a.id) &&
      (!q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    );
  }, [allAccounts, memberIds, search]);

  const members = useMemo(() =>
    allAccounts.filter(a => memberIds.has(a.id)).sort((a, b) => a.code.localeCompare(b.code)),
    [allAccounts, memberIds]
  );

  function addAccount(id: string) {
    setMemberIds(prev => new Set([...prev, id]));
  }

  function removeAccount(id: string) {
    setMemberIds(prev => { const s = new Set(prev); s.delete(id); return s; });
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');

    try {
      let groupId = group?.id;

      if (isNew) {
        const res = await apiFetch('/api/accounting/account-reporting-groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), report_type: reportType, display_order: displayOrder }),
        });
        await assertOk(res, 'Could not create the group - try again');
        const json = await res.json();
        groupId = json.data?.id;
      } else {
        const res = await apiFetch(`/api/accounting/account-reporting-groups?id=${group!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), report_type: reportType, display_order: displayOrder }),
        });
        await assertOk(res, 'Could not update the group - try again');
      }

      // Save members
      const membersRes = await apiFetch(
        `/api/accounting/account-reporting-groups/${groupId}/members`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gl_account_ids: Array.from(memberIds) }),
        }
      );
      await assertOk(membersRes, 'Could not save the group members - try again');

      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the group - try again'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
            {isNew ? 'New Reporting Group' : 'Edit Reporting Group'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-5">
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          {/* Group fields */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-1">
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Name *</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Current Assets"
                className="ff-input w-full text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Report Type *</label>
              <select
                value={reportType}
                onChange={e => setReportType(e.target.value as typeof reportType)}
                className="ff-input w-full text-sm"
              >
                {Object.entries(REPORT_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Display Order</label>
              <input
                type="number"
                value={displayOrder}
                onChange={e => setDisplayOrder(Number(e.target.value))}
                className="ff-input w-full text-sm"
                min={0}
                step={10}
              />
            </div>
          </div>

          {/* Dual-list */}
          <div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mb-2">
              GL Accounts — click arrows or account names to move between lists
            </p>
            <div className="grid grid-cols-[1fr_40px_1fr] gap-2">
              {/* Available */}
              <div className="border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
                <div className="px-3 py-2 border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]">
                  <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
                    Available ({available.length})
                  </p>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ff-text-tertiary)]" />
                    <input
                      type="text"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search..."
                      className="ff-input w-full text-xs pl-6 py-1"
                    />
                  </div>
                </div>
                <div className="overflow-y-auto max-h-52">
                  {loadingAccounts ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-[var(--ff-text-tertiary)]" />
                    </div>
                  ) : available.length === 0 ? (
                    <p className="text-xs text-[var(--ff-text-tertiary)] px-3 py-3">No accounts available</p>
                  ) : available.map(a => (
                    <button
                      key={a.id}
                      onClick={() => addAccount(a.id)}
                      className="w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--ff-bg-tertiary)] flex items-center justify-between group"
                    >
                      <span className="text-[var(--ff-text-secondary)]">
                        <span className="font-mono text-[var(--ff-text-tertiary)] mr-2">{a.code}</span>
                        {a.name}
                      </span>
                      <ChevronRight className="h-3 w-3 text-[var(--ff-text-tertiary)] opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Arrow column */}
              <div className="flex items-center justify-center">
                <div className="flex flex-col gap-1">
                  <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                  <ChevronLeft className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                </div>
              </div>

              {/* Members */}
              <div className="border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
                <div className="px-3 py-2 border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]">
                  <p className="text-xs font-medium text-[var(--ff-text-secondary)]">
                    In Group ({members.length})
                  </p>
                </div>
                <div className="overflow-y-auto max-h-52">
                  {members.length === 0 ? (
                    <p className="text-xs text-[var(--ff-text-tertiary)] px-3 py-3">No accounts in group</p>
                  ) : members.map(a => (
                    <button
                      key={a.id}
                      onClick={() => removeAccount(a.id)}
                      className="w-full px-3 py-1.5 text-left text-xs hover:bg-red-500/10 flex items-center justify-between group"
                    >
                      <span className="text-[var(--ff-text-secondary)]">
                        <span className="font-mono text-[var(--ff-text-tertiary)] mr-2">{a.code}</span>
                        {a.name}
                        {!a.isActive && <span className="ml-2 text-amber-500">(inactive)</span>}
                      </span>
                      <ChevronLeft className="h-3 w-3 text-red-400 opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--ff-border-light)] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg hover:bg-[var(--ff-bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {isNew ? 'Create Group' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
