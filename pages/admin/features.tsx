/**
 * Admin — Feature Flags
 * View and edit all platform feature flags. Features are seeded via migration,
 * so create/delete is not exposed here — only name, description, and is_global.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { AlertCircle, Loader2, ToggleLeft, ToggleRight } from 'lucide-react';
import {
  FeatureFlagRow,
  type FeatureFlag,
  type EditState,
} from '@/components/admin/FeatureFlagRow';
import { adminFetch } from '@/lib/admin/adminFetch';

export default function AdminFeaturesPage() {
  const [flags, setFlags]         = useState<FeatureFlag[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [editing, setEditing]     = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ name: '', description: '', is_global: false });
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState('');
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [bulkWorking, setBulkWorking] = useState(false);
  const [bulkNotice, setBulkNotice]   = useState('');
  const afterDelay = useTimeoutOnce();
  // Global availability changes for every tenant at once: it waits for a confirm (audit 3.7).
  const [pendingGlobal, setPendingGlobal] = useState<{ kind: 'bulk'; value: boolean } | { kind: 'edit'; id: string; value: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await adminFetch('/api/admin/features');
      await assertOk(res, 'Could not load the feature flags - try again');
      const json = await res.json() as { data?: FeatureFlag[]; message?: string };
      setFlags(json.data ?? []);
    } catch (err) {
      setFlags([]);
      setError(apiErrorMessage(err, 'Could not load the feature flags - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openEdit(flag: FeatureFlag) {
    setBulkNotice('');
    setEditing(flag.id);
    setEditState({ name: flag.name, description: flag.description ?? '', is_global: flag.is_global });
    setSaveError('');
  }

  function cancelEdit() { setEditing(null); setSaveError(''); }

  function requestSave(id: string) {
    const flag = flags.find((f) => f.id === id);
    if (flag && flag.is_global !== editState.is_global) { setPendingGlobal({ kind: 'edit', id, value: editState.is_global }); return; }
    void saveEdit(id);
  }

  async function saveEdit(id: string) {
    setSaving(true);
    setSaveError('');
    try {
      const res = await adminFetch(`/api/admin/features/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editState.name.trim() || undefined,
          description: editState.description.trim() || undefined,
          is_global: editState.is_global,
        }),
      });
      await assertOk(res, 'Could not save the feature flag - try again');
      const json = await res.json() as { data?: FeatureFlag; message?: string };
      setFlags((prev) => prev.map((f) => (f.id === id && json.data ? json.data : f)));
      setEditing(null);
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save the feature flag - try again'));
    } finally {
      setSaving(false);
    }
  }

  async function bulkSetGlobal(isGlobal: boolean) {
    if (selected.size === 0) return;
    setBulkWorking(true); setBulkNotice('');
    try {
      // Each apiFetch resolves on 4xx, so each flag's own result is checked; the outcome lists the failures
      // instead of one "some flags may not have been updated" (audit 3.7).
      const ids = Array.from(selected);
      const results = await Promise.allSettled(ids.map(async (id) => {
        const res = await adminFetch(`/api/admin/features/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_global: isGlobal }),
        });
        await assertOk(res, 'Could not update a feature flag - try again');
      }));
      const failed = ids.filter((_, i) => results[i]?.status === 'rejected')
        .map((id) => flags.find((f) => f.id === id)?.code ?? id);
      // Reload FIRST: load() opens with setError(''), so a message set before it would be wiped.
      await load();
      setSelected(new Set());
      const done = `${isGlobal ? 'Enabled' : 'Disabled'} globally: ${ids.length - failed.length} updated`;
      if (failed.length) setError(`${done}, ${failed.length} failed (${failed.join(', ')})`);
      else {
        setBulkNotice(`${done}.`);
        afterDelay(() => setBulkNotice(''), 8000); // or sooner, on the next selection or edit
      }
    } finally {
      setBulkWorking(false);
    }
  }

  const toggleSelectAll = () => {
    setBulkNotice('');
    setSelected(selected.size === flags.length ? new Set() : new Set(flags.map((f) => f.id)));
  };

  const toggleOne = (id: string) => {
    setBulkNotice('');
    setSelected((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  };

  return (
    <AdminLayout title="Feature Flags">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Feature flags control access to platform capabilities.
          Flags are seeded via migration — edit names, descriptions, and global availability here.
        </p>
        <span className="text-sm text-gray-500 dark:text-gray-400">{flags.length} flags</span>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-4 px-4 py-2 bg-teal-500/10 border border-teal-500/30 rounded-lg">
          <span className="text-sm text-teal-400 font-medium">{selected.size} selected</span>
          <button
            onClick={() => setPendingGlobal({ kind: 'bulk', value: true })}
            disabled={bulkWorking}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {bulkWorking ? <Loader2 className="w-3 h-3 animate-spin" /> : <ToggleRight className="w-3.5 h-3.5" />}
            Enable Selected
          </button>
          <button
            onClick={() => setPendingGlobal({ kind: 'bulk', value: false })}
            disabled={bulkWorking}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-slate-900 dark:text-white text-xs font-medium rounded-lg transition-colors"
          >
            {bulkWorking ? <Loader2 className="w-3 h-3 animate-spin" /> : <ToggleLeft className="w-3.5 h-3.5" />}
            Disable Selected
          </button>
          <button onClick={() => setSelected(new Set())} className="text-xs text-gray-600 dark:text-gray-400 hover:text-gray-200 ml-1">
            Clear
          </button>
        </div>
      )}

      {bulkNotice && (
        <div role="status" className="p-3 rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400 text-sm mb-4">{bulkNotice}</div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <th className="px-4 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={flags.length > 0 && selected.size === flags.length}
                    onChange={toggleSelectAll}
                    aria-label="Select all feature flags"
                    className="rounded"
                  />
                </th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium">Global</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium w-16"></th>
              </tr>
            </thead>
            <tbody>
              {loading && flags.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" />
                  </td>
                </tr>
              )}
              {!loading && flags.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-600 dark:text-gray-400">No feature flags found</td>
                </tr>
              )}
              {flags.map((flag) => (
                <FeatureFlagRow
                  key={flag.id}
                  flag={flag}
                  isEditing={editing === flag.id}
                  editState={editState}
                  saving={saving}
                  saveError={saveError}
                  isSelected={selected.has(flag.id)}
                  onToggleSelect={() => toggleOne(flag.id)}
                  onOpenEdit={() => openEdit(flag)}
                  onCancelEdit={cancelEdit}
                  onSaveEdit={() => requestSave(flag.id)}
                  onEditChange={(patch) => setEditState((s) => ({ ...s, ...patch }))}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <ConfirmModal
        open={pendingGlobal !== null}
        title={pendingGlobal?.value ? 'Make globally available?' : 'Remove global availability?'}
        message={pendingGlobal?.kind === 'bulk'
          ? <>{pendingGlobal.value ? 'Turn on' : 'Turn off'} global availability for <strong>{selected.size} feature flag{selected.size === 1 ? '' : 's'}</strong>. This can change access for every tenant at once.</>
          : <>{pendingGlobal?.value ? 'Turn on' : 'Turn off'} global availability for this feature flag. This can change access for every tenant at once.</>}
        confirmLabel={pendingGlobal?.value ? 'Enable globally' : 'Disable globally'}
        confirmClass="bg-amber-500 hover:bg-amber-600"
        loading={bulkWorking || saving}
        onConfirm={() => {
          const p = pendingGlobal;
          setPendingGlobal(null);
          if (p?.kind === 'bulk') void bulkSetGlobal(p.value);
          else if (p?.kind === 'edit') void saveEdit(p.id);
        }}
        onCancel={() => setPendingGlobal(null)}
      />
    </AdminLayout>
  );
}
