/**
 * Supplier Activity Timeline Tab
 * Displays a chronological feed of supplier activities (notes, calls, emails, etc.)
 * and provides an inline form for creating new activity entries.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  MessageSquare, Phone, Mail, DollarSign, FileText, RefreshCw,
  Clock, Plus, Trash2, Loader2, AlertCircle,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

type ActivityType =
  | 'note'
  | 'call'
  | 'email_sent'
  | 'email_received'
  | 'payment_made'
  | 'invoice_received'
  | 'status_change';

interface SupplierActivity {
  id: string;
  supplier_id: string;
  activity_type: ActivityType;
  subject: string | null;
  description: string;
  created_at: string | Date;
  created_by: string;
  created_by_email: string | null;
  created_by_first_name: string | null;
  created_by_last_name: string | null;
}

const ACTIVITY_TYPE_OPTIONS: { value: ActivityType; label: string }[] = [
  { value: 'note',             label: 'Note' },
  { value: 'call',             label: 'Call' },
  { value: 'email_sent',       label: 'Email Sent' },
  { value: 'email_received',   label: 'Email Received' },
];

const EMPTY_FORM = { activity_type: 'note' as ActivityType, subject: '', description: '' };

function activityIcon(type: ActivityType) {
  switch (type) {
    case 'note':              return <MessageSquare className="h-4 w-4" />;
    case 'call':              return <Phone         className="h-4 w-4" />;
    case 'email_sent':
    case 'email_received':    return <Mail          className="h-4 w-4" />;
    case 'payment_made':      return <DollarSign    className="h-4 w-4" />;
    case 'invoice_received':  return <FileText      className="h-4 w-4" />;
    case 'status_change':     return <RefreshCw     className="h-4 w-4" />;
  }
}

function activityIconColor(type: ActivityType): string {
  switch (type) {
    case 'note':              return 'bg-blue-500/10 text-blue-400';
    case 'call':              return 'bg-teal-500/10 text-teal-400';
    case 'email_sent':
    case 'email_received':    return 'bg-purple-500/10 text-purple-400';
    case 'payment_made':      return 'bg-green-500/10 text-green-400';
    case 'invoice_received':  return 'bg-orange-500/10 text-orange-400';
    case 'status_change':     return 'bg-yellow-500/10 text-yellow-400';
  }
}

function activityTypeLabel(type: ActivityType): string {
  const map: Record<ActivityType, string> = {
    note:             'Note',
    call:             'Call',
    email_sent:       'Email Sent',
    email_received:   'Email Received',
    payment_made:     'Payment Made',
    invoice_received: 'Invoice Received',
    status_change:    'Status Change',
  };
  return map[type] ?? type;
}

function relativeTime(raw: string | Date): string {
  const date   = raw instanceof Date ? raw : new Date(raw);
  const diffMs  = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60)  return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)  return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr  = Math.floor(diffMin / 60);
  if (diffHr  < 24)  return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr  / 24);
  if (diffDay < 30)  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString('en-ZA');
}

function creatorName(activity: SupplierActivity): string {
  const first = activity.created_by_first_name?.trim() ?? '';
  const last  = activity.created_by_last_name?.trim()  ?? '';
  if (first || last) return `${first} ${last}`.trim();
  return activity.created_by_email ?? 'Unknown';
}

export function ActivityTab({ supplierId }: { supplierId: string }) {
  const [activities, setActivities] = useState<SupplierActivity[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [showForm, setShowForm]     = useState(false);
  const [saving, setSaving]         = useState(false);
  const [form, setForm]             = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch(`/api/accounting/supplier-activities?supplierId=${supplierId}`);
      const json = await res.json() as { data?: SupplierActivity[] } | SupplierActivity[];
      const data = (json as { data?: SupplierActivity[] }).data ?? (json as SupplierActivity[]);
      setActivities(data);
    } catch (err) {
      log.error('Failed to load supplier activities', { supplierId, error: err }, 'activity-tab');
      setError('Failed to load activities');
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    if (!form.description.trim()) return;
    setSaving(true);
    setError('');
    try {
      await apiFetch('/api/accounting/supplier-activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId,
          activity_type: form.activity_type,
          subject:       form.subject.trim() || undefined,
          description:   form.description.trim(),
        }),
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      void load();
    } catch (err) {
      log.error('Failed to add supplier activity', { supplierId, error: err }, 'activity-tab');
      setError('Failed to save activity');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError('');
    try {
      await apiFetch(`/api/accounting/supplier-activities?id=${id}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      log.error('Failed to delete supplier activity', { id, error: err }, 'activity-tab');
      setError('Failed to delete activity');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {/* Header row */}
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-medium text-[var(--ff-text-secondary)] uppercase tracking-wide">
          Activity Timeline
        </h3>
        <button
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
        >
          <Plus className="h-4 w-4" /> Add Activity
        </button>
      </div>

      {/* Add-activity form */}
      {showForm && (
        <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4 space-y-3">
          <p className="text-sm font-medium text-[var(--ff-text-primary)]">New Activity</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <select
              value={form.activity_type}
              onChange={e => setForm(f => ({ ...f, activity_type: e.target.value as ActivityType }))}
              className="input-field"
            >
              {ACTIVITY_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <input
              placeholder="Subject (optional)"
              value={form.subject}
              onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
              className="input-field"
            />
          </div>
          <textarea
            placeholder="Description *"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={3}
            className="input-field w-full resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={() => void handleAdd()}
              disabled={saving || !form.description.trim()}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {saving ? 'Saving...' : 'Save Activity'}
            </button>
            <button
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
              className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {activities.length === 0 && !showForm && (
        <div className="text-center py-12 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
          <Clock className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
          <p className="text-sm text-[var(--ff-text-secondary)]">No activities yet</p>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
            Log calls, notes and emails to keep track of supplier interactions
          </p>
        </div>
      )}

      {/* Timeline feed */}
      <div className="space-y-3">
        {activities.map(activity => (
          <div
            key={activity.id}
            className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4 flex items-start justify-between gap-4"
          >
            <div className="flex items-start gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${activityIconColor(activity.activity_type)}`}>
                {activityIcon(activity.activity_type)}
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-tertiary)]">
                    {activityTypeLabel(activity.activity_type)}
                  </span>
                  {activity.subject && (
                    <span className="text-sm font-medium text-[var(--ff-text-primary)]">
                      {activity.subject}
                    </span>
                  )}
                </div>
                <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5 whitespace-pre-wrap">
                  {activity.description}
                </p>
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1.5">
                  {creatorName(activity)} &middot; {relativeTime(activity.created_at)}
                </p>
              </div>
            </div>
            <button
              onClick={() => void handleDelete(activity.id)}
              title="Delete activity"
              className="p-1.5 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 transition-colors shrink-0"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
