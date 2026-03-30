/**
 * Admin Announcements Manager
 * List, create, edit, and delete system announcements.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import {
  AnnouncementModal,
  EMPTY_FORM,
  type AnnouncementFormState,
} from '@/components/admin/AnnouncementModal';
import { apiFetch } from '@/lib/apiFetch';
import { Plus, Pencil, Trash2, AlertCircle, Loader2 } from 'lucide-react';
import type { Announcement } from '@/modules/admin/types/admin.types';

const TYPE_BADGE: Record<string, string> = {
  info:        'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  warning:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  maintenance: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  feature:     'bg-teal-500/10 text-teal-600 dark:text-teal-400',
};

function fmtDate(v: string | null) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
}

function announcementToForm(item: Announcement): AnnouncementFormState {
  return {
    title:          item.title,
    message:        item.message,
    type:           item.type,
    target:         item.target,
    target_ids:     (item.target_ids ?? []).join(', '),
    starts_at:      item.starts_at ? item.starts_at.slice(0, 16) : '',
    ends_at:        item.ends_at   ? item.ends_at.slice(0, 16)   : '',
    is_dismissible: item.is_dismissible,
  };
}

export default function AdminAnnouncementsPage() {
  const [rows, setRows]         = useState<Announcement[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [editItem, setEditItem] = useState<Announcement | null>(null);
  const [showNew, setShowNew]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch('/api/admin/announcements?limit=100');
      const data = await res.json();
      setRows(data.data?.items ?? []);
    } catch {
      setError('Failed to load announcements.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (form: AnnouncementFormState) => {
    setSaving(true);
    try {
      const targetIds = form.target_ids
        ? form.target_ids.split(',').map(s => s.trim()).filter(Boolean)
        : [];
      const body = {
        title:          form.title,
        message:        form.message,
        type:           form.type,
        target:         form.target,
        target_ids:     targetIds,
        starts_at:      form.starts_at ? new Date(form.starts_at).toISOString() : undefined,
        ends_at:        form.ends_at   ? new Date(form.ends_at).toISOString()   : undefined,
        is_dismissible: form.is_dismissible,
      };

      if (editItem) {
        await apiFetch(`/api/admin/announcements/${editItem.id}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
      } else {
        await apiFetch('/api/admin/announcements', {
          method: 'POST', body: JSON.stringify(body),
        });
      }

      setEditItem(null);
      setShowNew(false);
      await load();
    } catch {
      // apiFetch throws on error — bubble to UI
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await apiFetch(`/api/admin/announcements/${deleteId}`, { method: 'DELETE' });
      setDeleteId(null);
      await load();
    } catch {
      setDeleteId(null);
    }
  };

  const isModalOpen = showNew || !!editItem;
  const modalInitial = editItem ? announcementToForm(editItem) : { ...EMPTY_FORM };

  return (
    <AdminLayout title="Announcements">
      {isModalOpen && (
        <AnnouncementModal
          initial={modalInitial}
          onClose={() => { setShowNew(false); setEditItem(null); }}
          onSave={handleSave}
          saving={saving}
        />
      )}

      <ConfirmModal
        open={!!deleteId}
        title="Delete Announcement"
        message="This will permanently remove the announcement. Users will no longer see it."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Announcements</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Platform messages shown to users in the app.
            </p>
          </div>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg"
          >
            <Plus className="w-4 h-4" />
            New Announcement
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-sm text-gray-500 dark:text-gray-400">
            No announcements yet. Create one to get started.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left">Title</th>
                  <th className="px-4 py-3 text-left">Type</th>
                  <th className="px-4 py-3 text-left">Target</th>
                  <th className="px-4 py-3 text-left">Starts</th>
                  <th className="px-4 py-3 text-left">Ends</th>
                  <th className="px-4 py-3 text-left">Dismiss.</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {rows.map((row) => (
                  <tr key={row.id} className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white max-w-xs truncate">
                      {row.title}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${TYPE_BADGE[row.type] ?? 'bg-gray-100 text-gray-600'}`}>
                        {row.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 capitalize">
                      {row.target}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {fmtDate(row.starts_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {fmtDate(row.ends_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {row.is_dismissible ? 'Yes' : 'No'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => setEditItem(row)}
                          className="text-gray-400 hover:text-teal-500" title="Edit">
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button onClick={() => setDeleteId(row.id)}
                          className="text-gray-400 hover:text-red-500" title="Delete">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
