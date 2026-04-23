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
import { Loader2, Mail, Calendar, ArrowRight, Settings } from 'lucide-react';
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

export default function DunningTemplatesPage() {
  const [templates, setTemplates] = useState<DunningTemplate[]>([]);
  const [settings, setSettings] = useState<DunningSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatingSettings, setUpdatingSettings] = useState(false);

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
              className={`border rounded-lg p-4 ${TONE_STYLES[t.tone]}`}
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
                  </div>
                  <div className="text-xs text-gray-700 mt-1 flex items-center gap-2">
                    <Calendar className="w-3 h-3" />
                    {t.days_overdue_min}–{t.days_overdue_max ?? '∞'} days overdue
                    {t.send_weekdays_only && <span>• weekdays only</span>}
                  </div>
                </div>
              </div>
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
