/**
 * Intercompany Reconciliation Page
 * View, record, and reconcile intercompany transactions across group companies.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Building2, Loader2, AlertCircle, Check, Plus, Link2, X, Calendar, Filter,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  StatCard,
  fmt,
  type IntercompanyTx,
  type ReconciliationStats,
} from '@/components/accounting/group/IntercompanyShared';
import {
  IntercompanyCreateModal,
  type CreateForm,
} from '@/components/accounting/group/IntercompanyCreateModal';
import { IntercompanyTable } from '@/components/accounting/group/IntercompanyTable';

interface CompanyGroup {
  id: string;
  name: string;
  companies: { id: string; name: string }[];
}

type TabKey = 'all' | 'unmatched' | 'matched' | 'variance';

function defaultRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  };
}

const BLANK_FORM: CreateForm = {
  sourceCompanyId: '', targetCompanyId: '', type: 'sale', amount: '',
  currency: 'ZAR', date: new Date().toISOString().slice(0, 10),
  description: '', journalEntryId: '',
};

export default function IntercompanyReconciliationPage() {
  const [groups, setGroups] = useState<CompanyGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const range = defaultRange();
  const [periodStart, setPeriodStart] = useState(range.start);
  const [periodEnd, setPeriodEnd] = useState(range.end);

  const [transactions, setTransactions] = useState<IntercompanyTx[]>([]);
  const [stats, setStats] = useState<ReconciliationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingTx, setLoadingTx] = useState(false);

  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [matchSelection, setMatchSelection] = useState<string[]>([]);
  const [form, setForm] = useState<CreateForm>(BLANK_FORM);

  const activeGroup = groups.find((g) => g.id === selectedGroupId);
  const companies = activeGroup?.companies || [];

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await apiFetch('/api/accounting/company-groups');
      if (res.ok) {
        const json = await res.json();
        const list: CompanyGroup[] = json.data?.items ?? json.data ?? [];
        setGroups(list);
        if (list.length > 0 && !selectedGroupId && list[0]) setSelectedGroupId(list[0].id);
      }
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;
    setLoadingTx(true);
    setMsg(null);
    const params = new URLSearchParams({
      group_id: selectedGroupId,
      ...(periodStart ? { period_start: periodStart } : {}),
      ...(periodEnd ? { period_end: periodEnd } : {}),
    });
    if (activeTab !== 'all') params.set('status', activeTab);

    const [txRes, reconRes] = await Promise.all([
      apiFetch(`/api/accounting/intercompany-transactions?${params}`),
      apiFetch(
        `/api/accounting/intercompany-transactions?group_id=${selectedGroupId}&action=reconciliation&period_start=${periodStart}&period_end=${periodEnd}`
      ),
    ]);
    if (txRes.ok) {
      const json = await txRes.json();
      setTransactions(json.data?.items || json.data || []);
    }
    if (reconRes.ok) {
      const json = await reconRes.json();
      setStats(json.data || null);
    }
    setLoadingTx(false);
  }, [selectedGroupId, periodStart, periodEnd, activeTab]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCreate = async () => {
    if (!form.sourceCompanyId || !form.targetCompanyId || !form.amount) return;
    setSaving(true);
    const res = await apiFetch('/api/accounting/intercompany-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: selectedGroupId,
        sourceCompanyId: form.sourceCompanyId,
        targetCompanyId: form.targetCompanyId,
        transactionType: form.type,
        amount: parseFloat(form.amount),
        currency: form.currency,
        transactionDate: form.date,
        description: form.description,
        sourceJournalEntryId: form.journalEntryId || undefined,
      }),
    });
    if (res.ok) {
      setMsg({ type: 'success', text: 'Transaction recorded' });
      setShowCreate(false);
      setForm(BLANK_FORM);
      await loadData();
    } else {
      const err = await res.json().catch(() => null);
      setMsg({ type: 'error', text: err?.message || 'Failed to create transaction' });
    }
    setSaving(false);
  };

  const toggleMatchSelect = (id: string) => {
    setMatchSelection((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1]!, id];
      return [...prev, id];
    });
  };

  const handleMatch = async () => {
    if (matchSelection.length !== 2) return;
    setSaving(true);
    const res = await apiFetch('/api/accounting/intercompany-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'match', sourceId: matchSelection[0], targetId: matchSelection[1] }),
    });
    if (res.ok) {
      setMsg({ type: 'success', text: 'Transactions matched' });
      setMatchSelection([]);
      await loadData();
    } else {
      const err = await res.json().catch(() => null);
      setMsg({ type: 'error', text: err?.message || 'Match failed' });
    }
    setSaving(false);
  };

  const filtered = activeTab === 'all' ? transactions : transactions.filter((t) => t.status === activeTab);
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unmatched', label: 'Unmatched' },
    { key: 'matched', label: 'Matched' },
    { key: 'variance', label: 'Variance' },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Building2 className="h-6 w-6 text-purple-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Intercompany Reconciliation
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  View, record, and reconcile intercompany transactions
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                <select
                  value={selectedGroupId}
                  onChange={(e) => setSelectedGroupId(e.target.value)}
                  className="px-3 py-1.5 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)]"
                >
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)}
                  className="px-2 py-1.5 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)]" />
                <span className="text-[var(--ff-text-tertiary)] text-sm">to</span>
                <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}
                  className="px-2 py-1.5 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)]" />
              </div>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium transition-colors"
              >
                <Plus className="h-4 w-4" /> Record Transaction
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {msg && (
            <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
              msg.type === 'success' ? 'bg-teal-500/10 text-teal-400' : 'bg-red-500/10 text-red-400'
            }`}>
              {msg.type === 'success' ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              {msg.text}
              <button onClick={() => setMsg(null)} className="ml-auto"><X className="h-4 w-4" /></button>
            </div>
          )}

          {stats && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Total Intercompany Volume" value={fmt(stats.totalVolume)}
                sub={`${stats.matchedCount + stats.unmatchedCount + stats.varianceCount} transaction(s)`} color="text-purple-400" />
              <StatCard label="Matched" value={fmt(stats.matchedAmount)}
                sub={`${stats.matchedCount} transaction(s)`} color="text-emerald-400" />
              <StatCard label="Unmatched" value={fmt(stats.unmatchedAmount)}
                sub={`${stats.unmatchedCount} transaction(s)`} color="text-red-400" />
              <StatCard label="Variance" value={fmt(stats.varianceAmount)}
                sub={`${stats.varianceCount} transaction(s)`} color="text-orange-400" />
            </div>
          )}

          <div className="flex items-center gap-1 border-b border-[var(--ff-border-light)]">
            {tabs.map((tab) => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? 'border-purple-500 text-purple-400'
                    : 'border-transparent text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)]'
                }`}>
                {tab.label}
              </button>
            ))}
            {matchSelection.length === 2 && (
              <button onClick={handleMatch} disabled={saving}
                className="ml-auto flex items-center gap-2 px-4 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium transition-colors">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                Match Selected ({matchSelection.length})
              </button>
            )}
            {matchSelection.length === 1 && (
              <span className="ml-auto text-xs text-[var(--ff-text-tertiary)] py-2">
                Select 1 more transaction to match
              </span>
            )}
          </div>

          <IntercompanyTable
            transactions={filtered}
            loading={loading || loadingTx}
            matchSelection={matchSelection}
            onToggleSelect={toggleMatchSelect}
          />
        </div>

        {showCreate && (
          <IntercompanyCreateModal
            form={form}
            companies={companies}
            saving={saving}
            onClose={() => setShowCreate(false)}
            onSubmit={handleCreate}
            onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          />
        )}
      </div>
    </AppLayout>
  );
}
