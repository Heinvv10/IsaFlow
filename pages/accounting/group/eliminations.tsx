/**
 * Elimination Adjustments Page
 * Manage intercompany elimination entries for consolidated reporting.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Loader2, AlertCircle, Plus, Zap } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import {
  fmt,
  selectClass,
  type EliminationType,
  type EliminationLine,
  type EliminationAdjustment,
  toEliminationRow,
} from '@/components/accounting/group/EliminationsShared';
import { EliminationsTable } from '@/components/accounting/group/EliminationsTable';
import { EliminationsCreateModal } from '@/components/accounting/group/EliminationsCreateModal';
import { EliminationsFlaggedNotice, parseFlagged, type FlaggedRow } from '@/components/accounting/group/EliminationsFlaggedNotice';
import { localISODate } from '@/lib/dateUtils';
import { DateField } from '@/components/ui/DateField';
import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';

interface EntityGroup { id: string; name: string; }

/**
 * The group's account code → id. Elimination lines are stored by group account ID (the
 * consolidated reports look them up by id), but the form takes the code a person knows.
 */
async function groupAccountIds(groupId: string): Promise<Map<string, string>> {
  const res = await apiFetch(`/api/accounting/company-groups?action=accounts&group_id=${encodeURIComponent(groupId)}`);
  await assertOk(res, 'Could not load the group chart of accounts');
  const json = (await res.json()) as { data?: { items?: Array<{ id?: unknown; accountCode?: unknown }> } };
  const map = new Map<string, string>();
  for (const a of json.data?.items ?? []) {
    if (typeof a.id === 'string' && typeof a.accountCode === 'string') map.set(a.accountCode, a.id);
  }
  return map;
}

const BLANK_LINES: EliminationLine[] = [
  { groupAccountCode: '', debit: 0, credit: 0 },
  { groupAccountCode: '', debit: 0, credit: 0 },
];

export default function EliminationsPage() {
  const [groups, setGroups] = useState<EntityGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [periodStart, setPeriodStart] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(() => localISODate());
  const [items, setItems] = useState<EliminationAdjustment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // the run's flagged drafts, for the group and period they were generated for (cleared when either changes)
  const [generateNotes, setGenerateNotes] = useState<FlaggedRow[]>([]);
  const scopeRef = useRef('');
  useEffect(() => { scopeRef.current = `${selectedGroupId}|${periodStart}|${periodEnd}`; setGenerateNotes([]); }, [selectedGroupId, periodStart, periodEnd]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formType, setFormType] = useState<EliminationType>('interco_revenue');
  const [formDescription, setFormDescription] = useState('');
  const [formPeriod, setFormPeriod] = useState(() => localISODate());
  const [formLines, setFormLines] = useState<EliminationLine[]>(BLANK_LINES);
  const [formError, setFormError] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/accounting/company-groups')
      .then(async (r) => { await assertOk(r, 'Could not load company groups - try again'); return r.json(); })
      .then((json) => {
        const list: EntityGroup[] = json.data?.items || json.data?.groups || json.data || [];
        setGroups(list);
        if (list.length > 0 && !selectedGroupId && list[0]) setSelectedGroupId(list[0].id);
      })
      .catch((err) => setError(apiErrorMessage(err, 'Could not load company groups - try again')));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;
    setLoading(true); setError('');
    const scope = `${selectedGroupId}|${periodStart}|${periodEnd}`;
    try {
      const params = new URLSearchParams({ group_id: selectedGroupId, action: 'eliminations', period_start: periodStart, period_end: periodEnd });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`);
      await assertOk(res, 'Could not load the elimination adjustments - try again');
      const json = await res.json();
      if (scopeRef.current !== scope) return;   // a list for a group or period no longer selected is dropped
      const list: unknown = (json.data || json).items;
      setItems(Array.isArray(list) ? list.map(toEliminationRow) : []);
    } catch (err) { setError(apiErrorMessage(err, 'Could not load the elimination adjustments - try again')); setItems([]); }
    finally { setLoading(false); }
  }, [selectedGroupId, periodStart, periodEnd]);

  useEffect(() => { void loadData(); }, [loadData]);

  /* Shared action helper — avoids triple-duplicating fetch + error handling */
  const postAction = useCallback(async (loadingKey: string, body: object, errMsg: string, onResult?: (json: unknown) => void) => {
    setActionLoading(loadingKey);
    try {
      const res = await apiFetch(
        `/api/accounting/consolidated-reports?group_id=${selectedGroupId}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      await assertOk(res, errMsg);
      // a committed generation always reloads: a body that does not parse gives no notes, never an error
      if (onResult) onResult(await res.json().catch(() => null));
      await loadData();
    } catch (err) {
      setError(apiErrorMessage(err, errMsg));
    } finally { setActionLoading(null); }
  }, [selectedGroupId, loadData]);

  // the eliminations this run drafted with a flag (possibly the same sale as a mirrored document) are shown, with why
  const handleAutoGenerate = () => {
    setGenerateNotes([]);
    const scope = `${selectedGroupId}|${periodStart}|${periodEnd}`;
    return postAction('auto-generate', { action: 'auto-eliminate', periodStart, periodEnd }, 'Could not generate the eliminations - try again',
      (json) => { if (scopeRef.current === scope) setGenerateNotes(parseFlagged(json)); });   // (a result for another group or period is dropped)
  };

  // a draft that may be the same sale as a mirrored document is posted only after the person confirms (the server refuses it otherwise)
  const [confirmPost, setConfirmPost] = useState<EliminationAdjustment | null>(null);
  const post = (id: string, confirmDuplicate: boolean) =>
    postAction(id, { action: 'post-elimination', adjustmentId: id, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }, 'Could not post the elimination - try again');
  const handlePost = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item?.mirroredDuplicateOf) { setConfirmPost(item); return; }
    return post(id, false);
  };

  const handleReverse = (id: string) =>
    postAction(id, { action: 'reverse-elimination', adjustmentId: id }, 'Could not reverse the elimination - try again');

  function resetForm() {
    setFormType('interco_revenue'); setFormDescription(''); setFormPeriod(localISODate());
    setFormLines(BLANK_LINES.map((l) => ({ ...l }))); setFormError('');
  }

  async function handleCreateSubmit(e: React.FormEvent<Element>) {
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
      const ids = await groupAccountIds(selectedGroupId);
      const unknown = formLines.map((l) => l.groupAccountCode.trim()).filter((c) => !ids.has(c));
      if (unknown.length > 0) {
        setFormError(`Not a group account code: ${[...new Set(unknown)].join(', ')}`);
        return;
      }
      const res = await apiFetch(
        `/api/accounting/consolidated-reports?group_id=${selectedGroupId}`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // The field names the route reads; the elimination is dated on the chosen day.
            action: 'create-elimination', adjustmentType: formType,
            description: formDescription, periodStart: formPeriod, periodEnd: formPeriod,
            lines: formLines.map((l) => ({
              groupAccountId: ids.get(l.groupAccountCode.trim()),
              debit: Number(l.debit || 0), credit: Number(l.credit || 0),
            })),
          }),
        }
      );
      await assertOk(res, 'Could not create the elimination - try again');
      setShowCreateModal(false); resetForm(); await loadData();
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not create the elimination - try again'));
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
              <DateField label="Period start" required value={periodStart || null} onChange={(iso, v) => { if (v.valid && iso) setPeriodStart(iso); }} />
              <DateField label="Period end" required value={periodEnd || null} onChange={(iso, v) => { if (v.valid && iso) setPeriodEnd(iso); }} />
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
                className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium"
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
          <EliminationsFlaggedNotice rows={generateNotes} onDismiss={() => setGenerateNotes([])} />
          {/* a failed load must not also say "none found" */}
          {!(error && items.length === 0 && !loading) && <EliminationsTable items={items} loading={loading} actionLoading={actionLoading} onPost={handlePost} onReverse={handleReverse} />}
        </div>

        <ConfirmDialog
          open={confirmPost !== null}
          title="Post a possible duplicate?"
          message={confirmPost ? `This elimination is possibly the same sale as mirrored document ${confirmPost.mirroredDuplicateOf}, which is eliminated automatically. Posting it would eliminate the sale twice.` : ''}
          confirmLabel="Post anyway" confirmTone="danger"
          onConfirm={() => { const id = confirmPost?.id; setConfirmPost(null); if (id) void post(id, true); }}
          onCancel={() => setConfirmPost(null)}
        />
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
