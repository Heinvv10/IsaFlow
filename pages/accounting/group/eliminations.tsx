/**
 * Elimination Adjustments Page
 * Manage intercompany elimination entries for consolidated reporting.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Loader2, AlertCircle, Plus, Zap } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { selectClass, type EliminationAdjustment, toEliminationRow } from '@/components/accounting/group/EliminationsShared';
import { EliminationsTable } from '@/components/accounting/group/EliminationsTable';
import { EliminationsCreateModal } from '@/components/accounting/group/EliminationsCreateModal';
import {
  EliminationsFlaggedNotice, parseFlagged, parseSkipped, type FlaggedRow, type SkippedRow,
} from '@/components/accounting/group/EliminationsFlaggedNotice';
import { MirroredDroppedNotice, parseDroppedMirrored, type DroppedMirrored } from '@/components/accounting/group/MirroredDroppedNotice';
import { useEliminationCreateForm } from '@/components/accounting/group/useEliminationCreateForm';
import { possibleDuplicateMessage } from '@/modules/accounting/services/reports/eliminationErrors';
import { localISODate } from '@/lib/dateUtils';
import { DateField } from '@/components/ui/DateField';
import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';

interface EntityGroup { id: string; name: string; }
interface PossibleDuplicate { id: string; ref: string; stands: boolean }
const NO_NOTES = { flagged: [] as FlaggedRow[], skipped: [] as SkippedRow[] };

/** A 409 of a post refused as a possible duplicate (the list was stale: the mirror was accepted after it loaded), or null. */
async function possibleDuplicateOf(res: Response, id: string): Promise<PossibleDuplicate | null> {
  if (res.status !== 409) return null;
  const json = await res.clone().json().catch(() => null) as { error?: { details?: { reason?: unknown; mirroredRef?: unknown; mirrorStands?: unknown } } } | null;
  const d = json?.error?.details;
  return d?.reason === 'possible_duplicate' && typeof d.mirroredRef === 'string' ? { id, ref: d.mirroredRef, stands: d.mirrorStands === true } : null;
}

export default function EliminationsPage() {
  const [groups, setGroups] = useState<EntityGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [periodStart, setPeriodStart] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(() => localISODate());
  const [items, setItems] = useState<EliminationAdjustment[]>([]);
  const [dropped, setDropped] = useState<DroppedMirrored[]>([]);
  const [reasonRequiredFrom, setReasonRequiredFrom] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // the run's flagged drafts and the rows it left to mirroring, for the group and period they were generated for (cleared when either changes)
  const [generateNotes, setGenerateNotes] = useState(NO_NOTES);
  const scopeRef = useRef('');
  useEffect(() => { scopeRef.current = `${selectedGroupId}|${periodStart}|${periodEnd}`; setGenerateNotes(NO_NOTES); }, [selectedGroupId, periodStart, periodEnd]);

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
    const current = () => scopeRef.current === scope;   // a response for a group or period no longer selected is dropped, success or failure
    try {
      const params = new URLSearchParams({ group_id: selectedGroupId, action: 'eliminations', period_start: periodStart, period_end: periodEnd });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`);
      await assertOk(res, 'Could not load the elimination adjustments - try again');
      const json = await res.json();
      if (!current()) return;
      const data = json.data || json;
      setItems(Array.isArray(data.items) ? data.items.map(toEliminationRow) : []);
      setDropped(parseDroppedMirrored(data));
      setReasonRequiredFrom(typeof data.reasonRequiredFrom === 'string' ? data.reasonRequiredFrom : null);
    } catch (err) {
      if (current()) { setError(apiErrorMessage(err, 'Could not load the elimination adjustments - try again')); setItems([]); setDropped([]); }
    } finally { if (current()) setLoading(false); }
  }, [selectedGroupId, periodStart, periodEnd]);

  useEffect(() => { void loadData(); }, [loadData]);
  const form = useEliminationCreateForm(selectedGroupId, reasonRequiredFrom, loadData);

  // a draft that may be the same sale as a mirrored document is posted only after the person confirms (the server refuses it otherwise)
  const [confirmPost, setConfirmPost] = useState<PossibleDuplicate | null>(null);

  /* Shared action helper — avoids triple-duplicating fetch + error handling */
  const postAction = useCallback(async (loadingKey: string, body: object, errMsg: string, onResult?: (json: unknown) => void) => {
    setActionLoading(loadingKey);
    try {
      const res = await apiFetch(
        `/api/accounting/consolidated-reports?group_id=${selectedGroupId}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      const dup = await possibleDuplicateOf(res, loadingKey);
      if (dup) { setConfirmPost(dup); await loadData(); return; }   // (a stale list: ask now, with what the server found)
      await assertOk(res, errMsg);
      // a committed generation always reloads: a body that does not parse gives no notes, never an error
      if (onResult) onResult(await res.json().catch(() => null));
      await loadData();
    } catch (err) {
      setError(apiErrorMessage(err, errMsg));
    } finally { setActionLoading(null); }
  }, [selectedGroupId, loadData]);

  const handleAutoGenerate = () => {
    setGenerateNotes(NO_NOTES);
    const scope = `${selectedGroupId}|${periodStart}|${periodEnd}`;
    return postAction('auto-generate', { action: 'auto-eliminate', periodStart, periodEnd }, 'Could not generate the eliminations - try again',
      (json) => { if (scopeRef.current === scope) setGenerateNotes({ flagged: parseFlagged(json), skipped: parseSkipped(json) }); });   // (another scope's result is dropped)
  };

  const post = (id: string, confirmDuplicate: boolean) =>
    postAction(id, { action: 'post-elimination', adjustmentId: id, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }, 'Could not post the elimination - try again');
  const handlePost = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item?.mirroredDuplicateOf) { setConfirmPost({ id, ref: item.mirroredDuplicateOf, stands: item.mirrorStands === true }); return; }
    return post(id, false);
  };

  const handleReverse = (id: string) =>
    postAction(id, { action: 'reverse-elimination', adjustmentId: id }, 'Could not reverse the elimination - try again');

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
                onClick={form.start}
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
          <MirroredDroppedNotice rows={dropped} />
          <EliminationsFlaggedNotice rows={generateNotes.flagged} skipped={generateNotes.skipped} onDismiss={() => setGenerateNotes(NO_NOTES)} />
          {/* a failed load must not also say "none found" */}
          {!(error && items.length === 0 && !loading) && <EliminationsTable items={items} loading={loading} actionLoading={actionLoading} onPost={handlePost} onReverse={handleReverse} />}
        </div>

        <ConfirmDialog
          open={confirmPost !== null}
          title="Post a possible duplicate?"
          message={confirmPost ? possibleDuplicateMessage(confirmPost.ref, confirmPost.stands) : ''}
          confirmLabel={confirmPost?.stands ? 'Post anyway' : 'Post'} confirmTone={confirmPost?.stands ? 'danger' : 'primary'}
          onConfirm={() => { const id = confirmPost?.id; setConfirmPost(null); if (id) void post(id, true); }}
          onCancel={() => setConfirmPost(null)}
        />
        {form.open && (
          <EliminationsCreateModal
            formType={form.type} formDescription={form.description} formPeriod={form.period}
            formLines={form.lines} formError={form.error} formSaving={form.saving}
            formReason={form.reason} onReasonChange={form.setReason} reasonRequiredFrom={form.needsReason ? reasonRequiredFrom : null}
            onClose={() => form.setOpen(false)}
            onSubmit={form.submit}
            onTypeChange={form.setType} onDescriptionChange={form.setDescription} onPeriodChange={form.setPeriod}
            onAddLine={() => form.setLines((p) => [...p, { groupAccountCode: '', debit: 0, credit: 0 }])}
            onRemoveLine={(idx) => form.setLines((p) => p.filter((_, i) => i !== idx))}
            onUpdateLine={(idx, field, value) => form.setLines((p) => p.map((l, i) => i === idx ? { ...l, [field]: value } : l))}
          />
        )}
      </div>
    </AppLayout>
  );
}
