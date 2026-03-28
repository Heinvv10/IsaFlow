/**
 * Intercompany Reconciliation
 * View, record, and reconcile intercompany transactions across group companies.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Building2,
  Loader2,
  AlertCircle,
  Check,
  Plus,
  Link2,
  X,
  ArrowLeftRight,
  Calendar,
  Filter,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

/* ── Formatters ── */
const fmt = (n: number, currency = 'ZAR') =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency }).format(n);

/* ── Types ── */
interface CompanyGroup {
  id: string;
  name: string;
  companies: { id: string; name: string }[];
}

interface IntercompanyTx {
  id: string;
  date: string;
  sourceCompanyId: string;
  sourceCompanyName: string;
  targetCompanyId: string;
  targetCompanyName: string;
  type: string;
  amount: number;
  currency: string;
  description: string;
  status: 'matched' | 'partial' | 'unmatched' | 'variance';
  matchedTxId?: string;
  journalEntryId?: string;
}

interface ReconciliationStats {
  totalVolume: number;
  matchedCount: number;
  matchedAmount: number;
  unmatchedCount: number;
  unmatchedAmount: number;
  varianceCount: number;
  varianceAmount: number;
}

type TabKey = 'all' | 'unmatched' | 'matched' | 'variance';

const TX_TYPES = [
  { value: 'sale', label: 'Sale' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'loan', label: 'Loan' },
  { value: 'dividend', label: 'Dividend' },
  { value: 'mgmt_fee', label: 'Management Fee' },
  { value: 'transfer', label: 'Transfer' },
] as const;

const STATUS_STYLES: Record<string, string> = {
  matched: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  partial: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  unmatched: 'bg-red-500/10 text-red-400 border-red-500/30',
  variance: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
};

/* ── Default date range: current month ── */
function defaultRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  };
}

export default function IntercompanyReconciliationPage() {
  /* ── State ── */
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

  // Matching state
  const [matchSelection, setMatchSelection] = useState<string[]>([]);

  // Create form state
  const [form, setForm] = useState({
    sourceCompanyId: '',
    targetCompanyId: '',
    type: 'sale',
    amount: '',
    currency: 'ZAR',
    date: new Date().toISOString().slice(0, 10),
    description: '',
    journalEntryId: '',
  });

  /* ── Helpers ── */
  const activeGroup = groups.find((g) => g.id === selectedGroupId);
  const companies = activeGroup?.companies || [];

  /* ── Load groups ── */
  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await apiFetch('/api/accounting/company-groups');
      if (res.ok) {
        const json = await res.json();
        const list: CompanyGroup[] = json.data?.items ?? json.data ?? [];
        setGroups(list);
        if (list.length > 0 && !selectedGroupId && list[0]) {
          setSelectedGroupId(list[0].id);
        }
      }
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Load transactions + stats ── */
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

  useEffect(() => {
    loadData();
  }, [loadData]);

  /* ── Create transaction ── */
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
      setForm({
        sourceCompanyId: '',
        targetCompanyId: '',
        type: 'sale',
        amount: '',
        currency: 'ZAR',
        date: new Date().toISOString().slice(0, 10),
        description: '',
        journalEntryId: '',
      });
      await loadData();
    } else {
      const err = await res.json().catch(() => null);
      setMsg({ type: 'error', text: err?.message || 'Failed to create transaction' });
    }
    setSaving(false);
  };

  /* ── Match two transactions ── */
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
      body: JSON.stringify({
        action: 'match',
        sourceId: matchSelection[0],
        targetId: matchSelection[1],
      }),
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

  /* ── Filtered transactions (client-side fallback) ── */
  const filtered = activeTab === 'all'
    ? transactions
    : transactions.filter((t) => t.status === activeTab);

  /* ── Tab config ── */
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unmatched', label: 'Unmatched' },
    { key: 'matched', label: 'Matched' },
    { key: 'variance', label: 'Variance' },
  ];

  /* ── Render ── */
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
              {/* Group Selector */}
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                <select
                  value={selectedGroupId}
                  onChange={(e) => setSelectedGroupId(e.target.value)}
                  className="px-3 py-1.5 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)]"
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Date Range */}
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                <input
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  className="px-2 py-1.5 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)]"
                />
                <span className="text-[var(--ff-text-tertiary)] text-sm">to</span>
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  className="px-2 py-1.5 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)]"
                />
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
          {/* Message banner */}
          {msg && (
            <div
              className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
                msg.type === 'success'
                  ? 'bg-teal-500/10 text-teal-400'
                  : 'bg-red-500/10 text-red-400'
              }`}
            >
              {msg.type === 'success' ? (
                <Check className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
              {msg.text}
              <button onClick={() => setMsg(null)} className="ml-auto">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Total Intercompany Volume"
                value={fmt(stats.totalVolume)}
                sub={`${stats.matchedCount + stats.unmatchedCount + stats.varianceCount} transaction(s)`}
                color="text-purple-400"
              />
              <StatCard
                label="Matched"
                value={fmt(stats.matchedAmount)}
                sub={`${stats.matchedCount} transaction(s)`}
                color="text-emerald-400"
              />
              <StatCard
                label="Unmatched"
                value={fmt(stats.unmatchedAmount)}
                sub={`${stats.unmatchedCount} transaction(s)`}
                color="text-red-400"
              />
              <StatCard
                label="Variance"
                value={fmt(stats.varianceAmount)}
                sub={`${stats.varianceCount} transaction(s)`}
                color="text-orange-400"
              />
            </div>
          )}

          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-[var(--ff-border-light)]">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? 'border-purple-500 text-purple-400'
                    : 'border-transparent text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)]'
                }`}
              >
                {tab.label}
              </button>
            ))}

            {/* Match button */}
            {matchSelection.length === 2 && (
              <button
                onClick={handleMatch}
                disabled={saving}
                className="ml-auto flex items-center gap-2 px-4 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium transition-colors"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
                Match Selected ({matchSelection.length})
              </button>
            )}
            {matchSelection.length > 0 && matchSelection.length < 2 && (
              <span className="ml-auto text-xs text-[var(--ff-text-tertiary)] py-2">
                Select 1 more transaction to match
              </span>
            )}
          </div>

          {/* Transaction Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading || loadingTx ? (
              <div className="p-12 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-12 text-center text-[var(--ff-text-tertiary)]">
                <ArrowLeftRight className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No intercompany transactions found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)] text-xs uppercase">
                      <th className="px-4 py-3 text-left w-8" />
                      <th className="px-4 py-3 text-left">Date</th>
                      <th className="px-4 py-3 text-left">Source Company</th>
                      <th className="px-4 py-3 text-left">Target Company</th>
                      <th className="px-4 py-3 text-left">Type</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                      <th className="px-4 py-3 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-light)]">
                    {filtered.map((tx) => {
                      const isSelected = matchSelection.includes(tx.id);
                      const canSelect = tx.status === 'unmatched' || tx.status === 'partial';
                      return (
                        <tr
                          key={tx.id}
                          onClick={() => canSelect && toggleMatchSelect(tx.id)}
                          className={`hover:bg-[var(--ff-bg-tertiary)] transition-colors ${
                            canSelect ? 'cursor-pointer' : ''
                          } ${isSelected ? 'bg-purple-500/5' : ''}`}
                        >
                          <td className="px-4 py-3">
                            {canSelect && (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleMatchSelect(tx.id)}
                                className="rounded border-[var(--ff-border-light)]"
                              />
                            )}
                          </td>
                          <td className="px-4 py-3 text-[var(--ff-text-primary)] whitespace-nowrap">
                            {tx.date?.split('T')[0]}
                          </td>
                          <td className="px-4 py-3 text-[var(--ff-text-primary)]">
                            {tx.sourceCompanyName}
                          </td>
                          <td className="px-4 py-3 text-[var(--ff-text-primary)]">
                            {tx.targetCompanyName}
                          </td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">
                            {tx.type.replace('_', ' ')}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                            {fmt(tx.amount, tx.currency)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span
                              className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${
                                STATUS_STYLES[tx.status] || STATUS_STYLES.unmatched
                              }`}
                            >
                              {tx.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Create Transaction Modal ── */}
        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl w-full max-w-lg mx-4 shadow-2xl">
              <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ff-border-light)]">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                  Record Intercompany Transaction
                </h2>
                <button
                  onClick={() => setShowCreate(false)}
                  className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="px-6 py-4 space-y-4">
                {/* Source / Target */}
                <div className="grid grid-cols-2 gap-4">
                  <FieldSelect
                    label="Source Company"
                    value={form.sourceCompanyId}
                    onChange={(v) => setForm((f) => ({ ...f, sourceCompanyId: v }))}
                    options={companies.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder="Select..."
                  />
                  <FieldSelect
                    label="Target Company"
                    value={form.targetCompanyId}
                    onChange={(v) => setForm((f) => ({ ...f, targetCompanyId: v }))}
                    options={companies.filter((c) => c.id !== form.sourceCompanyId).map((c) => ({ value: c.id, label: c.name }))}
                    placeholder="Select..."
                  />
                </div>

                {/* Type + Currency */}
                <div className="grid grid-cols-2 gap-4">
                  <FieldSelect
                    label="Transaction Type"
                    value={form.type}
                    onChange={(v) => setForm((f) => ({ ...f, type: v }))}
                    options={TX_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                  />
                  <FieldInput
                    label="Currency"
                    value={form.currency}
                    onChange={(v) => setForm((f) => ({ ...f, currency: v }))}
                  />
                </div>

                {/* Amount + Date */}
                <div className="grid grid-cols-2 gap-4">
                  <FieldInput
                    label="Amount"
                    type="number"
                    value={form.amount}
                    onChange={(v) => setForm((f) => ({ ...f, amount: v }))}
                    placeholder="0.00"
                  />
                  <FieldInput
                    label="Date"
                    type="date"
                    value={form.date}
                    onChange={(v) => setForm((f) => ({ ...f, date: v }))}
                  />
                </div>

                {/* Description */}
                <FieldInput
                  label="Description"
                  value={form.description}
                  onChange={(v) => setForm((f) => ({ ...f, description: v }))}
                  placeholder="e.g. Management fee Q1 2026"
                />

                {/* Journal Entry Link (optional) */}
                <FieldInput
                  label="Journal Entry ID (optional)"
                  value={form.journalEntryId}
                  onChange={(v) => setForm((f) => ({ ...f, journalEntryId: v }))}
                  placeholder="Leave blank if not linked"
                />
              </div>

              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--ff-border-light)]">
                <button
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={saving || !form.sourceCompanyId || !form.targetCompanyId || !form.amount}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-40 transition-colors"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Record
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

/* ── Reusable sub-components ── */

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
      <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{label}</p>
      <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
      <p className="text-xs text-[var(--ff-text-tertiary)]">{sub}</p>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[var(--ff-text-tertiary)] uppercase">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full px-3 py-2 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)]"
      />
    </label>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[var(--ff-text-tertiary)] uppercase">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full px-3 py-2 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)]"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
