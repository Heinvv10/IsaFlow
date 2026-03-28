/**
 * Elimination Adjustments Page
 * Manage intercompany elimination entries for consolidated reporting.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Building2,
  Loader2,
  AlertCircle,
  Plus,
  Zap,
  Send,
  RotateCcw,
  X,
  Trash2,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface EntityGroup {
  id: string;
  name: string;
}

type EliminationType =
  | 'interco_revenue'
  | 'interco_balance'
  | 'unrealised_profit'
  | 'nci'
  | 'currency_translation'
  | 'goodwill';

type EliminationStatus = 'draft' | 'posted' | 'reversed';

interface EliminationAdjustment {
  id: string;
  number: string;
  type: EliminationType;
  description: string;
  period: string;
  status: EliminationStatus;
  amount: number;
  lines?: EliminationLine[];
}

interface EliminationLine {
  id?: string;
  groupAccountCode: string;
  groupAccountName?: string;
  debit: number;
  credit: number;
}

interface EliminationsResponse {
  items: EliminationAdjustment[];
  total: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const today = new Date();
const defaultPeriodStart = `${today.getFullYear()}-01-01`;
const defaultPeriodEnd = today.toISOString().substring(0, 10);

const selectClass =
  'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';
const inputClass = selectClass;

const ELIMINATION_TYPE_LABELS: Record<EliminationType, string> = {
  interco_revenue: 'Intercompany Revenue',
  interco_balance: 'Intercompany Balance',
  unrealised_profit: 'Unrealised Profit',
  nci: 'Non-Controlling Interest',
  currency_translation: 'Currency Translation',
  goodwill: 'Goodwill',
};

const STATUS_STYLES: Record<EliminationStatus, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  posted: 'bg-teal-500/10 text-teal-400',
  reversed: 'bg-amber-500/10 text-amber-400',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function EliminationsPage() {
  const [groups, setGroups] = useState<EntityGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd);

  const [data, setData] = useState<EliminationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Create modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formType, setFormType] = useState<EliminationType>('interco_revenue');
  const [formDescription, setFormDescription] = useState('');
  const [formPeriod, setFormPeriod] = useState(defaultPeriodEnd);
  const [formLines, setFormLines] = useState<EliminationLine[]>([
    { groupAccountCode: '', debit: 0, credit: 0 },
    { groupAccountCode: '', debit: 0, credit: 0 },
  ]);
  const [formError, setFormError] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  /* ---------- Load available groups ---------- */
  useEffect(() => {
    apiFetch('/api/accounting/company-groups')
      .then(r => r.json())
      .then(json => {
        const items: EntityGroup[] = json.data?.items || json.data?.groups || json.data || [];
        setGroups(items);
        if (items.length > 0 && !selectedGroupId && items[0]) {
          setSelectedGroupId(items[0].id);
        }
      })
      .catch(() => {
        // Non-critical — group list load failure
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Load eliminations ---------- */
  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        group_id: selectedGroupId,
        action: 'eliminations',
        period_start: periodStart,
        period_end: periodEnd,
      });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`);
      if (!res.ok) throw new Error('Failed to load elimination adjustments');
      const json = await res.json();
      const payload: EliminationsResponse = json.data || json;
      setData(payload);
    } catch {
      setError('Failed to load elimination adjustments');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId, periodStart, periodEnd]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /* ---------- Actions ---------- */
  async function handleAutoGenerate() {
    if (!selectedGroupId) return;
    setActionLoading('auto-generate');
    try {
      const params = new URLSearchParams({ group_id: selectedGroupId });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'auto-eliminate',
          period_start: periodStart,
          period_end: periodEnd,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message || 'Auto-generation failed');
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-generation failed');
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePost(adjustmentId: string) {
    if (!selectedGroupId) return;
    setActionLoading(adjustmentId);
    try {
      const params = new URLSearchParams({ group_id: selectedGroupId });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'post-elimination',
          elimination_id: adjustmentId,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message || 'Failed to post elimination');
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post elimination');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReverse(adjustmentId: string) {
    if (!selectedGroupId) return;
    setActionLoading(adjustmentId);
    try {
      const params = new URLSearchParams({ group_id: selectedGroupId });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reverse-elimination',
          elimination_id: adjustmentId,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message || 'Failed to reverse elimination');
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reverse elimination');
    } finally {
      setActionLoading(null);
    }
  }

  /* ---------- Create Modal ---------- */
  function resetForm() {
    setFormType('interco_revenue');
    setFormDescription('');
    setFormPeriod(defaultPeriodEnd);
    setFormLines([
      { groupAccountCode: '', debit: 0, credit: 0 },
      { groupAccountCode: '', debit: 0, credit: 0 },
    ]);
    setFormError('');
  }

  function addLine() {
    setFormLines(prev => [...prev, { groupAccountCode: '', debit: 0, credit: 0 }]);
  }

  function removeLine(idx: number) {
    setFormLines(prev => prev.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, field: keyof EliminationLine, value: string | number) {
    setFormLines(prev =>
      prev.map((line, i) => (i === idx ? { ...line, [field]: value } : line)),
    );
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedGroupId) return;

    const totalDebit = formLines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const totalCredit = formLines.reduce((s, l) => s + Number(l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      setFormError(`Debits (${fmt(totalDebit)}) must equal credits (${fmt(totalCredit)})`);
      return;
    }
    if (formLines.some(l => !l.groupAccountCode)) {
      setFormError('All lines must have a group account code');
      return;
    }

    setFormSaving(true);
    setFormError('');
    try {
      const params = new URLSearchParams({ group_id: selectedGroupId });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create-elimination',
          type: formType,
          description: formDescription,
          period: formPeriod,
          lines: formLines.map(l => ({
            group_account_code: l.groupAccountCode,
            debit: Number(l.debit || 0),
            credit: Number(l.credit || 0),
          })),
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message || 'Failed to create elimination');
      }
      setShowCreateModal(false);
      resetForm();
      await loadData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create elimination');
    } finally {
      setFormSaving(false);
    }
  }

  const items = data?.items || [];

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Building2 className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Elimination Adjustments
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Intercompany eliminations for consolidated reporting
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={selectedGroupId}
                onChange={e => setSelectedGroupId(e.target.value)}
                className={selectClass}
              >
                {groups.length === 0 && <option value="">No groups</option>}
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <input
                type="date"
                value={periodStart}
                onChange={e => setPeriodStart(e.target.value)}
                className={inputClass}
              />
              <input
                type="date"
                value={periodEnd}
                onChange={e => setPeriodEnd(e.target.value)}
                className={inputClass}
              />
              <button
                onClick={handleAutoGenerate}
                disabled={!selectedGroupId || actionLoading === 'auto-generate'}
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium disabled:opacity-50"
              >
                {actionLoading === 'auto-generate' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                Auto-Generate
              </button>
              <button
                onClick={() => { resetForm(); setShowCreateModal(true); }}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> Manual Elimination
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {/* Error banner */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {/* States: loading / empty / list */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-12">
              <Building2 className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">
                No elimination adjustments found
              </p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                Use &ldquo;Auto-Generate&rdquo; to detect intercompany transactions or create manually
              </p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                    <th className="px-4 py-3">Number</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Period</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(adj => (
                    <tr
                      key={adj.id}
                      className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                    >
                      <td className="px-4 py-3 font-mono text-[var(--ff-text-tertiary)]">
                        {adj.number}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">
                        {ELIMINATION_TYPE_LABELS[adj.type] || adj.type}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)] max-w-xs truncate">
                        {adj.description}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-tertiary)] font-mono text-xs">
                        {adj.period}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[adj.status]}`}>
                          {adj.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                        {fmt(adj.amount)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {adj.status === 'draft' && (
                            <button
                              onClick={() => handlePost(adj.id)}
                              disabled={actionLoading === adj.id}
                              title="Post elimination"
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-teal-600 text-white rounded-md hover:bg-teal-700 text-xs font-medium disabled:opacity-50"
                            >
                              {actionLoading === adj.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Send className="h-3 w-3" />
                              )}
                              Post
                            </button>
                          )}
                          {adj.status === 'posted' && (
                            <button
                              onClick={() => handleReverse(adj.id)}
                              disabled={actionLoading === adj.id}
                              title="Reverse elimination"
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-amber-600 text-white rounded-md hover:bg-amber-700 text-xs font-medium disabled:opacity-50"
                            >
                              {actionLoading === adj.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3 w-3" />
                              )}
                              Reverse
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---------- Create Elimination Modal ---------- */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-[var(--ff-surface-primary)] rounded-xl border border-[var(--ff-border-light)] w-full max-w-2xl max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ff-border-light)]">
                <h2 className="text-lg font-bold text-[var(--ff-text-primary)]">
                  Create Manual Elimination
                </h2>
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleCreateSubmit} className="p-6 space-y-4">
                {formError && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
                    <AlertCircle className="h-4 w-4 shrink-0" /> {formError}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Type</label>
                    <select
                      value={formType}
                      onChange={e => setFormType(e.target.value as EliminationType)}
                      className={selectClass + ' w-full'}
                    >
                      {(Object.keys(ELIMINATION_TYPE_LABELS) as EliminationType[]).map(t => (
                        <option key={t} value={t}>{ELIMINATION_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Period</label>
                    <input
                      type="date"
                      value={formPeriod}
                      onChange={e => setFormPeriod(e.target.value)}
                      className={inputClass + ' w-full'}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Description</label>
                  <input
                    type="text"
                    value={formDescription}
                    onChange={e => setFormDescription(e.target.value)}
                    placeholder="Describe the elimination adjustment..."
                    className={inputClass + ' w-full'}
                    required
                  />
                </div>

                {/* Lines */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-[var(--ff-text-tertiary)]">Journal Lines</label>
                    <button
                      type="button"
                      onClick={addLine}
                      className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300"
                    >
                      <Plus className="h-3 w-3" /> Add Line
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div className="grid grid-cols-[1fr_100px_100px_32px] gap-2 text-xs text-[var(--ff-text-tertiary)]">
                      <span>Group Account Code</span>
                      <span className="text-right">Debit</span>
                      <span className="text-right">Credit</span>
                      <span />
                    </div>
                    {formLines.map((line, idx) => (
                      <div key={idx} className="grid grid-cols-[1fr_100px_100px_32px] gap-2">
                        <input
                          type="text"
                          value={line.groupAccountCode}
                          onChange={e => updateLine(idx, 'groupAccountCode', e.target.value)}
                          placeholder="e.g. 4000"
                          className={inputClass + ' w-full'}
                          required
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={line.debit || ''}
                          onChange={e => updateLine(idx, 'debit', parseFloat(e.target.value) || 0)}
                          placeholder="0.00"
                          className={inputClass + ' w-full text-right'}
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={line.credit || ''}
                          onChange={e => updateLine(idx, 'credit', parseFloat(e.target.value) || 0)}
                          placeholder="0.00"
                          className={inputClass + ' w-full text-right'}
                        />
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          disabled={formLines.length <= 2}
                          className="p-1.5 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 disabled:opacity-30"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-[1fr_100px_100px_32px] gap-2 mt-2 pt-2 border-t border-[var(--ff-border-light)] text-xs font-medium text-[var(--ff-text-primary)]">
                    <span>Totals</span>
                    <span className="text-right font-mono">
                      {fmt(formLines.reduce((s, l) => s + Number(l.debit || 0), 0))}
                    </span>
                    <span className="text-right font-mono">
                      {fmt(formLines.reduce((s, l) => s + Number(l.credit || 0), 0))}
                    </span>
                    <span />
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-[var(--ff-border-light)]">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={formSaving}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50"
                  >
                    {formSaving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    Create Elimination
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
