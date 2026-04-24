/**
 * Dunning Templates page (PRD-06 Phase 5).
 *
 * Lists the four SA-default templates (auto-seeded) and any custom ones.
 * Shows each tone's ladder range, the escalation order, and a preview of
 * subject + body. Edit/create deferred to a follow-up UI; API supports it.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, Mail, Calendar, ArrowRight, Settings, Pencil, Trash2, X, Save } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface DunningTemplate {
  id: string;
  name: string;
  tone: 'polite' | 'firm' | 'final' | 'legal';
  escalation_order: number;
  days_overdue_min: number;
  days_overdue_max: number | null;
  subject_template: string;
  body_template: string;
  send_weekdays_only: boolean;
  active: boolean;
}

interface DunningSettings {
  auto_send_enabled: boolean;
  min_outstanding_zar: number;
}

const TONE_STYLES: Record<DunningTemplate['tone'], string> = {
  polite: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  firm: 'bg-amber-100 text-amber-900 border-amber-300',
  final: 'bg-orange-100 text-orange-900 border-orange-300',
  legal: 'bg-red-100 text-red-900 border-red-300',
};

type EditDraft = Pick<
  DunningTemplate,
  'name' | 'subject_template' | 'body_template' | 'days_overdue_min' | 'days_overdue_max' | 'send_weekdays_only'
>;

export default function DunningTemplatesPage() {
  const [templates, setTemplates] = useState<DunningTemplate[]>([]);
  const [settings, setSettings] = useState<DunningSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatingSettings, setUpdatingSettings] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const startEdit = useCallback((t: DunningTemplate) => {
    setEditingId(t.id);
    setDraft({
      name: t.name,
      subject_template: t.subject_template,
      body_template: t.body_template,
      days_overdue_min: t.days_overdue_min,
      days_overdue_max: t.days_overdue_max,
      send_weekdays_only: t.send_weekdays_only,
    });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId || !draft) return;
    try {
      setSaving(true);
      const res = await apiFetch(`/api/accounting/ar/dunning/templates/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `PUT failed: ${res.status}`);
      }
      const json = await res.json();
      const updated = json?.data as DunningTemplate | undefined;
      if (updated) {
        setTemplates((prev) => prev.map((t) => (t.id === editingId ? updated : t)));
      }
      cancelEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [editingId, draft, cancelEdit]);

  const deactivateTemplate = useCallback(async (id: string, name: string) => {
    // eslint-disable-next-line no-alert
    if (!confirm(`Deactivate "${name}"? The template stays in history but the cron will skip it.`)) return;
    try {
      const res = await apiFetch(`/api/accounting/ar/dunning/templates/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE failed: ${res.status}`);
      setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, active: false } : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deactivate failed');
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [tRes, sRes] = await Promise.all([
        apiFetch('/api/accounting/ar/dunning/templates'),
        apiFetch('/api/accounting/ar/dunning/settings'),
      ]);
      const tJson = await tRes.json();
      const sJson = await sRes.json();
      setTemplates(tJson?.data?.templates ?? []);
      setSettings(sJson?.data?.settings ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleAutoSend = useCallback(async () => {
    if (!settings) return;
    try {
      setUpdatingSettings(true);
      const res = await apiFetch('/api/accounting/ar/dunning/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_send_enabled: !settings.auto_send_enabled }),
      });
      const json = await res.json();
      setSettings(json?.data?.settings ?? settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Settings update failed');
    } finally {
      setUpdatingSettings(false);
    }
  }, [settings]);

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64 text-gray-500">
          <Loader2 className="animate-spin mr-2" /> Loading dunning templates…
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Mail className="w-6 h-6" /> Dunning Templates
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Escalation ladder for overdue customer invoices. Four SA defaults
              are seeded automatically — edit or add custom tones per company.
            </p>
          </div>
          <Link
            href="/accounting/ar/dunning/runs"
            className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md"
          >
            View send history <ArrowRight className="w-4 h-4" />
          </Link>
        </header>

        {error && (
          <div className="border border-red-300 bg-red-50 text-red-800 rounded-md p-3 text-sm">
            {error}
          </div>
        )}

        {settings && (
          <section className="border rounded-lg p-4 bg-gray-50 flex items-center gap-4">
            <Settings className="w-5 h-5 text-gray-700" />
            <div className="flex-1">
              <div className="font-medium text-gray-900">
                Automated daily send {settings.auto_send_enabled
                  ? <span className="text-emerald-700">ON</span>
                  : <span className="text-gray-500">OFF</span>}
              </div>
              <div className="text-xs text-gray-600 mt-1">
                When ON, the daily cron walks overdue invoices through the ladder
                and sends templates automatically (weekdays only, respecting cool-off).
                Minimum outstanding: R{Number(settings.min_outstanding_zar).toFixed(2)}.
              </div>
            </div>
            <button
              type="button"
              onClick={toggleAutoSend}
              disabled={updatingSettings}
              className={`px-3 py-2 text-sm rounded-md text-white ${
                settings.auto_send_enabled
                  ? 'bg-gray-600 hover:bg-gray-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              } disabled:opacity-50`}
            >
              {updatingSettings ? 'Saving…' : settings.auto_send_enabled ? 'Disable' : 'Enable'}
            </button>
          </section>
        )}

        <section className="space-y-3">
          {templates.map((t) => (
            <div
              key={t.id}
              className={`border rounded-lg p-4 ${TONE_STYLES[t.tone]} ${!t.active ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{t.name}</span>
                    <span className="text-xs uppercase tracking-wide px-2 py-0.5 bg-white/60 rounded">
                      {t.tone}
                    </span>
                    <span className="text-xs text-gray-700">
                      escalation #{t.escalation_order}
                    </span>
                    {!t.active && (
                      <span className="text-xs px-2 py-0.5 bg-gray-200 text-gray-700 rounded">
                        inactive
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-700 mt-1 flex items-center gap-2">
                    <Calendar className="w-3 h-3" />
                    {t.days_overdue_min}–{t.days_overdue_max ?? '∞'} days overdue
                    {t.send_weekdays_only && <span>• weekdays only</span>}
                  </div>
                </div>
                {editingId !== t.id && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(t)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-white/80 hover:bg-white rounded border border-current"
                      aria-label={`Edit ${t.name}`}
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    {t.active && (
                      <button
                        type="button"
                        onClick={() => deactivateTemplate(t.id, t.name)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-white/80 hover:bg-red-50 rounded border border-current text-red-800"
                        aria-label={`Deactivate ${t.name}`}
                      >
                        <Trash2 className="w-3 h-3" /> Deactivate
                      </button>
                    )}
                  </div>
                )}
              </div>

              {editingId === t.id && draft ? (
                <div className="mt-3 space-y-2 bg-white/70 rounded p-3">
                  <label className="block text-xs">
                    <span className="font-medium">Name</span>
                    <input
                      type="text"
                      className="mt-1 w-full border rounded px-2 py-1 text-sm"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </label>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <label>
                      <span className="font-medium">Days min</span>
                      <input
                        type="number" min={0}
                        className="mt-1 w-full border rounded px-2 py-1 text-sm"
                        value={draft.days_overdue_min}
                        onChange={(e) => setDraft({ ...draft, days_overdue_min: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      <span className="font-medium">Days max (blank = ∞)</span>
                      <input
                        type="number" min={0}
                        className="mt-1 w-full border rounded px-2 py-1 text-sm"
                        value={draft.days_overdue_max ?? ''}
                        onChange={(e) => setDraft({
                          ...draft,
                          days_overdue_max: e.target.value === '' ? null : Number(e.target.value),
                        })}
                      />
                    </label>
                    <label className="flex items-end gap-1">
                      <input
                        type="checkbox"
                        checked={draft.send_weekdays_only}
                        onChange={(e) => setDraft({ ...draft, send_weekdays_only: e.target.checked })}
                      />
                      <span className="font-medium">Weekdays only</span>
                    </label>
                  </div>
                  <label className="block text-xs">
                    <span className="font-medium">Subject</span>
                    <input
                      type="text"
                      className="mt-1 w-full border rounded px-2 py-1 font-mono text-xs"
                      value={draft.subject_template}
                      onChange={(e) => setDraft({ ...draft, subject_template: e.target.value })}
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="font-medium">Body</span>
                    <textarea
                      rows={8}
                      className="mt-1 w-full border rounded px-2 py-1 font-mono text-xs"
                      value={draft.body_template}
                      onChange={(e) => setDraft({ ...draft, body_template: e.target.value })}
                    />
                  </label>
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={saving}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 rounded"
                    >
                      <X className="w-3 h-3" /> Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={saving}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                    >
                      <Save className="w-3 h-3" /> {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-3 text-sm">
                    <div className="font-medium">Subject</div>
                    <div className="font-mono text-xs bg-white/70 rounded p-2 mt-1">
                      {t.subject_template}
                    </div>
                  </div>
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-gray-800">Body template</summary>
                    <pre className="mt-2 whitespace-pre-wrap text-xs bg-white/70 rounded p-2">
                      {t.body_template}
                    </pre>
                  </details>
                </>
              )}
            </div>
          ))}
          {templates.length === 0 && (
            <div className="text-sm text-gray-500 p-6 text-center border rounded">
              No templates configured. Refresh to auto-seed SA defaults.
            </div>
          )}
        </section>
      </div>
    </AppLayout>
  );
}
