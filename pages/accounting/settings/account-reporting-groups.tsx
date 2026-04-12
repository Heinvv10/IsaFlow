/**
 * Account Reporting Groups Settings Page
 * Manage custom GL account groupings for financial report subtotals (Sage parity)
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Layers, Plus, Pencil, Trash2, Loader2, AlertCircle, FileText,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { AccountReportingGroupModal } from '@/components/accounting/AccountReportingGroupModal';

interface GroupMember {
  gl_account_id: string;
  account_code: string;
  account_name: string;
}

interface AccountReportingGroup {
  id: string;
  name: string;
  report_type: 'balance_sheet' | 'income_statement' | 'both';
  display_order: number;
  member_count: number;
  members: GroupMember[];
  created_at: string;
}

const REPORT_TYPE_LABELS: Record<string, string> = {
  balance_sheet: 'Balance Sheet',
  income_statement: 'Income Statement',
  both: 'Both',
};

const REPORT_TYPE_COLOURS: Record<string, string> = {
  balance_sheet: 'bg-blue-500/10 text-blue-400',
  income_statement: 'bg-teal-500/10 text-teal-400',
  both: 'bg-purple-500/10 text-purple-400',
};

export default function AccountReportingGroupsPage() {
  const [groups, setGroups] = useState<AccountReportingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalGroup, setModalGroup] = useState<AccountReportingGroup | null | undefined>(undefined);
  // undefined = modal closed, null = new group, object = edit group
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/account-reporting-groups');
      const json = await res.json();
      if (!res.ok) { setError(json.message ?? 'Failed to load groups'); return; }
      setGroups(json.data?.items ?? []);
    } catch {
      setError('Failed to load reporting groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadGroups(); }, [loadGroups]);

  async function handleDelete(id: string) {
    if (confirmDelete !== id) { setConfirmDelete(id); return; }
    setDeleting(id);
    setConfirmDelete(null);
    try {
      const res = await apiFetch(`/api/accounting/account-reporting-groups?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) { setError(json.message ?? 'Failed to delete group'); return; }
      setGroups(prev => prev.filter(g => g.id !== id));
    } catch {
      setError('Failed to delete group');
    } finally {
      setDeleting(null);
    }
  }

  function handleModalSaved() {
    setModalGroup(undefined);
    void loadGroups();
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link
              href="/accounting/chart-of-accounts"
              className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2"
            >
              <ArrowLeft className="h-4 w-4" /> Accounts
            </Link>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <Layers className="h-6 w-6 text-blue-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Reporting Groups</h1>
                  <p className="text-sm text-[var(--ff-text-tertiary)]">
                    Custom GL account groups for Balance Sheet and Income Statement subtotals
                  </p>
                </div>
              </div>
              <button
                onClick={() => setModalGroup(null)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> New Group
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            </div>
          ) : groups.length === 0 ? (
            <div className="text-center py-16">
              <Layers className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-4 opacity-40" />
              <p className="text-[var(--ff-text-secondary)] font-medium mb-1">No reporting groups yet</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mb-6">
                Create groups to add custom subtotals to your financial reports
              </p>
              <button
                onClick={() => setModalGroup(null)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> Create First Group
              </button>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
              <div className="divide-y divide-[var(--ff-border-light)]">
                {groups.map(group => (
                  <div
                    key={group.id}
                    className="px-6 py-4 flex items-center gap-4 hover:bg-[var(--ff-bg-tertiary)]"
                  >
                    <div className="p-2 rounded-lg bg-blue-500/5 shrink-0">
                      <FileText className="h-5 w-5 text-blue-400" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-[var(--ff-text-primary)]">{group.name}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${REPORT_TYPE_COLOURS[group.report_type] ?? ''}`}>
                          {REPORT_TYPE_LABELS[group.report_type]}
                        </span>
                        {group.display_order !== 0 && (
                          <span className="text-xs text-[var(--ff-text-tertiary)]">
                            Order: {group.display_order}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">
                        {group.member_count} account{group.member_count !== 1 ? 's' : ''}
                        {group.members.length > 0 && (
                          <span className="ml-2 text-[var(--ff-text-tertiary)]">
                            {group.members.slice(0, 3).map(m => m.account_code).join(', ')}
                            {group.member_count > 3 ? ` +${group.member_count - 3} more` : ''}
                          </span>
                        )}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => setModalGroup(group)}
                        className="p-2 rounded-lg text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)]"
                        title="Edit group"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => void handleDelete(group.id)}
                        disabled={deleting === group.id}
                        className={`p-2 rounded-lg ${
                          confirmDelete === group.id
                            ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                            : 'text-[var(--ff-text-tertiary)] hover:text-red-400 hover:bg-[var(--ff-bg-primary)]'
                        }`}
                        title={confirmDelete === group.id ? 'Click again to confirm delete' : 'Delete group'}
                      >
                        {deleting === group.id
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Trash2 className="h-4 w-4" />
                        }
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {modalGroup !== undefined && (
        <AccountReportingGroupModal
          group={modalGroup}
          onClose={() => setModalGroup(undefined)}
          onSaved={handleModalSaved}
        />
      )}
    </AppLayout>
  );
}
