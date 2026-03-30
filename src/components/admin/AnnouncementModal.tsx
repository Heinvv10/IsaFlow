/**
 * AnnouncementModal
 * Create / edit form for system announcements.
 */

import { useState } from 'react';
import { Loader2, X } from 'lucide-react';

export const EMPTY_FORM = {
  title: '', message: '', type: 'info', target: 'all',
  target_ids: '', starts_at: '', ends_at: '', is_dismissible: true,
} as const;

export type AnnouncementFormState = {
  title: string;
  message: string;
  type: string;
  target: string;
  target_ids: string;
  starts_at: string;
  ends_at: string;
  is_dismissible: boolean;
};

interface Props {
  initial: AnnouncementFormState;
  onClose: () => void;
  onSave: (data: AnnouncementFormState) => Promise<void>;
  saving: boolean;
}

const INPUT_CLS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-3 py-2 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500';

export function AnnouncementModal({ initial, onClose, onSave, saving }: Props) {
  const [form, setForm] = useState<AnnouncementFormState>(initial);
  const set = <K extends keyof AnnouncementFormState>(k: K, v: AnnouncementFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {initial.title ? 'Edit Announcement' : 'New Announcement'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Title</label>
            <input value={form.title} onChange={e => set('title', e.target.value)} className={INPUT_CLS} />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Message</label>
            <textarea rows={3} value={form.message} onChange={e => set('message', e.target.value)}
              className={`${INPUT_CLS} resize-none`} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Type</label>
              <select value={form.type} onChange={e => set('type', e.target.value)} className={INPUT_CLS}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="maintenance">Maintenance</option>
                <option value="feature">Feature</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Target</label>
              <select value={form.target} onChange={e => set('target', e.target.value)} className={INPUT_CLS}>
                <option value="all">All</option>
                <option value="plan">Plan</option>
                <option value="company">Company</option>
              </select>
            </div>
          </div>

          {form.target !== 'all' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Target IDs (comma-separated UUIDs)
              </label>
              <input value={form.target_ids} onChange={e => set('target_ids', e.target.value)}
                placeholder="uuid1, uuid2, ..." className={INPUT_CLS} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Starts At</label>
              <input type="datetime-local" value={form.starts_at}
                onChange={e => set('starts_at', e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Ends At (optional)
              </label>
              <input type="datetime-local" value={form.ends_at}
                onChange={e => set('ends_at', e.target.value)} className={INPUT_CLS} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input type="checkbox" checked={form.is_dismissible}
              onChange={e => set('is_dismissible', e.target.checked)}
              className="rounded border-gray-300 text-teal-600 focus:ring-teal-500" />
            Dismissible by users
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
            Cancel
          </button>
          <button
            onClick={() => onSave(form)}
            disabled={saving || !form.title || !form.message || !form.starts_at}
            className="px-4 py-2 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
