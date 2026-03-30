/**
 * Admin — Feature Flags
 * View and edit all platform feature flags. Features are seeded via migration,
 * so create/delete is not exposed here — only name, description, and is_global.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2, Pencil, Globe, Lock, X, Check } from 'lucide-react';

interface FeatureFlag {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_global: boolean;
  created_at: string;
}

interface EditState {
  name: string;
  description: string;
  is_global: boolean;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-ZA');
}

export default function AdminFeaturesPage() {
  const [flags, setFlags]         = useState<FeatureFlag[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [editing, setEditing]     = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ name: '', description: '', is_global: false });
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState('');

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
    setEditState({
      name: flag.name,
      description: flag.description ?? '',
      is_global: flag.is_global,
    });
    setSaveError('');
  }

  function cancelEdit() {
    setEditing(null);
    setSaveError('');
  }

  async function saveEdit(id: string) {
    setSaving(true);
    setSaveError('');
    try {
      const res = await apiFetch(`/api/admin/features/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editState.name.trim() || undefined,
          description: editState.description.trim() || undefined,
          is_global: editState.is_global,
        }),
      });
      const json = await res.json() as { data?: FeatureFlag; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to save');

      setFlags((prev) =>
        prev.map((f) => (f.id === id && json.data ? json.data : f))
      );
      setEditing(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminLayout title="Feature Flags">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Feature flags control access to platform capabilities.
          Flags are seeded via migration — edit names, descriptions, and global availability here.
        </p>
        <span className="text-sm text-gray-500 dark:text-gray-400">{flags.length} flags</span>
      </div>

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
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" />
                  </td>
                </tr>
              )}
              {!loading && flags.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    No feature flags found
                  </td>
                </tr>
              )}

              {flags.map((flag) =>
                editing === flag.id ? (
                  // Edit row
                  <tr
                    key={flag.id}
                    className="border-b border-gray-100 dark:border-gray-800 last:border-0 bg-teal-50/40 dark:bg-teal-900/10"
                  >
                    <td className="px-4 py-3">
                      <code className="text-xs font-mono text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                        {flag.code}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        value={editState.name}
                        onChange={(e) => setEditState((s) => ({ ...s, name: e.target.value }))}
                        className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                        placeholder="Feature name"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        value={editState.description}
                        onChange={(e) => setEditState((s) => ({ ...s, description: e.target.value }))}
                        className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                        placeholder="Description"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setEditState((s) => ({ ...s, is_global: !s.is_global }))}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                          editState.is_global
                            ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        }`}
                      >
                        {editState.is_global
                          ? <><Globe className="w-3 h-3" /> Global</>
                          : <><Lock className="w-3 h-3" /> Plan only</>
                        }
                      </button>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{fmtDate(flag.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {saveError && (
                          <span className="text-xs text-red-500 mr-1">{saveError}</span>
                        )}
                        <button
                          onClick={() => void saveEdit(flag.id)}
                          disabled={saving}
                          className="p-1.5 rounded text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20 disabled:opacity-40 transition-colors"
                          title="Save"
                        >
                          {saving
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Check className="w-4 h-4" />
                          }
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={saving}
                          className="p-1.5 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  // Read-only row
                  <tr
                    key={flag.id}
                    className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <code className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                        {flag.code}
                      </code>
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                      {flag.name}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 max-w-xs truncate">
                      {flag.description || <span className="italic text-gray-300 dark:text-gray-600">No description</span>}
                    </td>
                    <td className="px-4 py-3">
                      {flag.is_global ? (
                        <span className="flex items-center gap-1 text-xs text-teal-600 dark:text-teal-400">
                          <Globe className="w-3.5 h-3.5" /> Global
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-gray-400">
                          <Lock className="w-3.5 h-3.5" /> Plan only
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                      {fmtDate(flag.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => openEdit(flag)}
                        className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        title="Edit feature flag"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
