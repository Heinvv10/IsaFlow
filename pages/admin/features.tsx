/**
 * Admin — Feature Flags
 * View and edit all platform feature flags. Features are seeded via migration,
 * so create/delete is not exposed here — only name, description, and is_global.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2, ToggleLeft, ToggleRight } from 'lucide-react';
import {
  FeatureFlagRow,
  type FeatureFlag,
  type EditState,
} from '@/components/admin/FeatureFlagRow';

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

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch('/api/admin/features');
      const json = await res.json() as { data?: FeatureFlag[]; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load features');
      setFlags(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load features');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openEdit(flag: FeatureFlag) {
    setEditing(flag.id);
    setEditState({ name: flag.name, description: flag.description ?? '', is_global: flag.is_global });
    setSaveError('');
  }

  function cancelEdit() { setEditing(null); setSaveError(''); }

  async function saveEdit(id: string) {
    setSaving(true);
    setSaveError('');
    try {
      const res = await apiFetch(`/api/admin/features/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({
          name: editState.name.trim() || undefined,
          description: editState.description.trim() || undefined,
          is_global: editState.is_global,
        }),
      });
      const json = await res.json() as { data?: FeatureFlag; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to save');
      setFlags((prev) => prev.map((f) => (f.id === id && json.data ? json.data : f)));
      setEditing(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function bulkSetGlobal(isGlobal: boolean) {
    if (selected.size === 0) return;
    setBulkWorking(true);
    try {
      await Promise.all(
        Array.from(selected).map((id) =>
          apiFetch(`/api/admin/features/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
            body: JSON.stringify({ is_global: isGlobal }),
          })
        )
      );
      setSelected(new Set());
      await load();
    } catch {
      setError('Bulk update failed — some flags may not have updated');
    } finally {
      setBulkWorking(false);
    }
  }

  const toggleSelectAll = () => {
    setSelected(selected.size === flags.length ? new Set() : new Set(flags.map((f) => f.id)));
  };

  const toggleOne = (id: string) => {
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
            onClick={() => void bulkSetGlobal(true)}
            disabled={bulkWorking}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {bulkWorking ? <Loader2 className="w-3 h-3 animate-spin" /> : <ToggleRight className="w-3.5 h-3.5" />}
            Enable Selected
          </button>
          <button
            onClick={() => void bulkSetGlobal(false)}
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
                  onSaveEdit={() => void saveEdit(flag.id)}
                  onEditChange={(patch) => setEditState((s) => ({ ...s, ...patch }))}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
