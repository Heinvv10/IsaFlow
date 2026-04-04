/**
 * Elimination Adjustments Page
 * Manage intercompany elimination entries for consolidated reporting.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Loader2, AlertCircle, Plus, Zap } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  fmt,
  selectClass,
  inputClass,
  type EliminationType,
  type EliminationLine,
  type EliminationAdjustment,
} from '@/components/accounting/group/EliminationsShared';
import { EliminationsTable } from '@/components/accounting/group/EliminationsTable';
import { EliminationsCreateModal } from '@/components/accounting/group/EliminationsCreateModal';

interface EntityGroup { id: string; name: string; }

const today = new Date();
const DEFAULT_PERIOD_START = `${today.getFullYear()}-01-01`;
const DEFAULT_PERIOD_END = today.toISOString().substring(0, 10);
const BLANK_LINES: EliminationLine[] = [
  { groupAccountCode: '', debit: 0, credit: 0 },
  { groupAccountCode: '', debit: 0, credit: 0 },
];

export default function EliminationsPage() {
  const [groups, setGroups] = useState<EntityGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [periodStart, setPeriodStart] = useState(DEFAULT_PERIOD_START);
  const [periodEnd, setPeriodEnd] = useState(DEFAULT_PERIOD_END);
  const [items, setItems] = useState<EliminationAdjustment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formType, setFormType] = useState<EliminationType>('interco_revenue');
  const [formDescription, setFormDescription] = useState('');
  const [formPeriod, setFormPeriod] = useState(DEFAULT_PERIOD_END);
  const [formLines, setFormLines] = useState<EliminationLine[]>(BLANK_LINES);
  const [formError, setFormError] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/accounting/company-groups')
      .then((r) => r.json())
      .then((json) => {
        const list: EntityGroup[] = json.data?.items || json.data?.groups || json.data || [];
        setGroups(list);
        if (list.length > 0 && !selectedGroupId && list[0]) setSelectedGroupId(list[0].id);
      })
      .catch(() => { /* non-critical */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ group_id: selectedGroupId, action: 'eliminations', period_start: periodStart, period_end: periodEnd });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`);
      if (!res.ok) throw new Error('Failed to load elimination adjustments');
      const json = await res.json();
      setItems((json.data || json).items || []);
    } catch { setError('Failed to load elimination adjustments'); setItems([]); }
    finally { setLoading(false); }
  }, [selectedGroupId, periodStart, periodEnd]);

  useEffect(() => { loadData(); }, [loadData]);

  /* Shared action helper — avoids triple-duplicating fetch + error handling */
  const postAction = useCallback(async (loadingKey: string, body: object, errMsg: string) => {
    setActionLoading(loadingKey);
    try {
      const res = await apiFetch(
        `/api/accounting/consolidated-reports?group_id=${selectedGroupId}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message || errMsg);
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : errMsg);
    } finally { setActionLoading(null); }
  }, [selectedGroupId, loadData]);

  const handleAutoGenerate = () =>
    postAction('auto-generate', { action: 'auto-eliminate', period_start: periodStart, period_end: periodEnd }, 'Auto-generation failed');

  const handlePost = (id: string) =>
    postAction(id, { action: 'post-elimination', elimination_id: id }, 'Failed to post elimination');

  const handleReverse = (id: string) =>
    postAction(id, { action: 'reverse-elimination', elimination_id: id }, 'Failed to reverse elimination');

  function resetForm() {
    setFormType('interco_revenue'); setFormDescription(''); setFormPeriod(DEFAULT_PERIOD_END);
    setFormLines(BLANK_LINES.map((l) => ({ ...l }))); setFormError('');
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
    if (formLines.some((l) => !l.groupAccountCode)) {
      setFormError('All lines must have a group account code');
      return;
    }
    setFormSaving(true); setFormError('');
    try {
      const res = await apiFetch(
        `/api/accounting/consolidated-reports?group_id=${selectedGroupId}`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create-elimination', type: formType,
            description: formDescription, period: formPeriod,
            lines: formLines.map((l) => ({
              group_account_code: l.groupAccountCode,
              debit: Number(l.debit || 0), credit: Number(l.credit || 0),
            })),
          }),
        }
      );
      if (!res.ok) { const json = await res.json(); throw new Error(json.message || 'Failed to create elimination'); }
      setShowCreateModal(false); resetForm(); await loadData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create elimination');
    } finally { setFormSaving(false); }
  }

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
              <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)} className={selectClass}>
                {groups.length === 0 && <option value="">No groups</option>}
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className={inputClass} />
              <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className={inputClass} />
              <button
                onClick={handleAutoGenerate}
                disabled={!selectedGroupId || actionLoading === 'auto-generate'}
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium disabled:opacity-50"
              >
                {actionLoading === 'auto-generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
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
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}
          <EliminationsTable items={items} loading={loading} actionLoading={actionLoading} onPost={handlePost} onReverse={handleReverse} />
        </div>

        {showCreateModal && (
          <EliminationsCreateModal
            formType={formType} formDescription={formDescription} formPeriod={formPeriod}
            formLines={formLines} formError={formError} formSaving={formSaving}
            onClose={() => setShowCreateModal(false)}
            onSubmit={handleCreateSubmit}
            onTypeChange={setFormType} onDescriptionChange={setFormDescription} onPeriodChange={setFormPeriod}
            onAddLine={() => setFormLines((p) => [...p, { groupAccountCode: '', debit: 0, credit: 0 }])}
            onRemoveLine={(idx) => setFormLines((p) => p.filter((_, i) => i !== idx))}
            onUpdateLine={(idx, field, value) => setFormLines((p) => p.map((l, i) => i === idx ? { ...l, [field]: value } : l))}
          />
        )}
      </div>
    </AppLayout>
  );
}
