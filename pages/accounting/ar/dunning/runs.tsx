/**
 * Dunning Runs page (PRD-06 Phase 5).
 *
 * Shows every dunning send — manual + cron — with response tracking.
 * Filter by response action to triage silent/disputed customers.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, History, ArrowLeft, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

type Tone = 'polite' | 'firm' | 'final' | 'legal';
type EmailStatus = 'sent' | 'failed' | 'pending';
type ResponseAction = 'paid' | 'promised' | 'disputed' | 'silent';
type TriggerSource = 'manual' | 'cron' | 'auto';
type ResponseFilter = '' | ResponseAction | 'none';

interface SendRow {
  id: string;
  invoice_number: string;
  customer_name: string;
  template_name: string;
  template_tone: Tone;
  sent_at: string;
  sent_to_email: string;
  rendered_subject: string;
  trigger_source: TriggerSource;
  email_status: EmailStatus;
  email_error: string | null;
  response_action: ResponseAction | null;
  response_received_at: string | null;
  response_note: string | null;
  message_token: string;
}

const TONE_DOT: Record<Tone, string> = {
  polite: 'bg-emerald-500', firm: 'bg-amber-500',
  final: 'bg-orange-500',   legal: 'bg-red-500',
};

const RESPONSE_LABEL: Record<ResponseAction, string> = {
  paid: 'Paid',  promised: 'Promised',  disputed: 'Disputed',  silent: 'Silent',
};

const RESPONSE_BADGE: Record<ResponseAction, string> = {
  paid:     'bg-emerald-100 text-emerald-800',
  promised: 'bg-blue-100 text-blue-800',
  disputed: 'bg-red-100 text-red-800',
  silent:   'bg-gray-100 text-gray-700',
};

function fmtDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-ZA')} ${d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}`;
}

export default function DunningRunsPage() {
  const [sends, setSends] = useState<SendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ResponseFilter>('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const url = filter
        ? `/api/accounting/ar/dunning/sends?responseAction=${filter}&limit=200`
        : '/api/accounting/ar/dunning/sends?limit=200';
      const res = await apiFetch(url);
      const json = await res.json();
      setSends(json?.data?.sends ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load send history');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const totals = {
    total: sends.length,
    sent: sends.filter((s) => s.email_status === 'sent').length,
    failed: sends.filter((s) => s.email_status === 'failed').length,
    paid: sends.filter((s) => s.response_action === 'paid').length,
    promised: sends.filter((s) => s.response_action === 'promised').length,
    disputed: sends.filter((s) => s.response_action === 'disputed').length,
    silent: sends.filter((s) => s.response_action === null).length,
  };

  const responseRate = totals.sent > 0
    ? Math.round(((totals.paid + totals.promised + totals.disputed) / totals.sent) * 100)
    : 0;

  return (
    <AppLayout>
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <Link
              href="/accounting/ar/dunning"
              className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline mb-2"
            >
              <ArrowLeft className="w-4 h-4" /> Back to templates
            </Link>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <History className="w-6 h-6" /> Dunning Send History
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Every reminder — manual + cron — with response tracking.
            </p>
          </div>
        </header>

        {error && (
          <div className="border border-red-300 bg-red-50 text-red-800 rounded-md p-3 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Stat label="Sent" value={totals.sent} tone="emerald" />
          <Stat label="Failed" value={totals.failed} tone="red" />
          <Stat label="Paid" value={totals.paid} tone="emerald" />
          <Stat label="Promised" value={totals.promised} tone="blue" />
          <Stat label="Disputed" value={totals.disputed} tone="red" />
          <Stat label="Response rate" value={`${responseRate}%`} tone="gray" />
        </section>

        <div className="flex gap-2 text-sm">
          {(['', 'none', 'paid', 'promised', 'disputed', 'silent'] as ResponseFilter[]).map((f) => (
            <button
              key={f || 'all'}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md border ${
                filter === f
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {f === '' ? 'All' : f === 'none' ? 'Awaiting response' : RESPONSE_LABEL[f as ResponseAction]}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-500">
            <Loader2 className="animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <div className="border rounded-lg overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-700 text-left">
                <tr>
                  <th className="px-3 py-2">Sent</th>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Tone</th>
                  <th className="px-3 py-2">Trigger</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Response</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                      {fmtDateTime(s.sent_at)}
                    </td>
                    <td className="px-3 py-2 font-medium">{s.invoice_number}</td>
                    <td className="px-3 py-2">{s.customer_name}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${TONE_DOT[s.template_tone]}`} />
                        {s.template_name}
                      </span>
                    </td>
                    <td className="px-3 py-2 capitalize text-gray-600">{s.trigger_source}</td>
                    <td className="px-3 py-2">
                      {s.email_status === 'sent' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700">
                          <CheckCircle2 className="w-4 h-4" /> Sent
                        </span>
                      ) : s.email_status === 'failed' ? (
                        <span className="inline-flex items-center gap-1 text-red-700" title={s.email_error ?? ''}>
                          <AlertCircle className="w-4 h-4" /> Failed
                        </span>
                      ) : (
                        <span className="text-gray-500">Pending</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {s.response_action ? (
                        <span className={`text-xs px-2 py-0.5 rounded ${RESPONSE_BADGE[s.response_action]}`}>
                          {RESPONSE_LABEL[s.response_action]}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {sends.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                      No sends yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function Stat({
  label, value, tone,
}: { label: string; value: number | string; tone: 'emerald' | 'red' | 'blue' | 'gray' }) {
  const toneMap = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    red:     'border-red-200 bg-red-50 text-red-900',
    blue:    'border-blue-200 bg-blue-50 text-blue-900',
    gray:    'border-gray-200 bg-gray-50 text-gray-900',
  };
  return (
    <div className={`border rounded-md p-3 ${toneMap[tone]}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}
