/**
 * SARS Submission History Page
 * Table of all past submissions with type, period, status, reference, and details.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  FileText, Loader2, ChevronLeft,
  CheckCircle2, Clock, XCircle, AlertTriangle,
  Eye,
} from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import { SubmissionDetailModal, type SubmissionDetail } from '@/components/accounting/sars/SubmissionDetailModal';

interface Submission extends SubmissionDetail {
  submittedBy: string | null;
}

const formatDateTime = (d: string) => {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const statusBadge = (status: string) => {
  const configs: Record<string, { icon: typeof CheckCircle2; className: string }> = {
    submitted: { icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-400' },
    accepted: { icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-400' },
    draft: { icon: Clock, className: 'bg-amber-500/10 text-amber-400' },
    generated: { icon: Clock, className: 'bg-blue-500/10 text-blue-400' },
    rejected: { icon: XCircle, className: 'bg-red-500/10 text-red-400' },
  };
  const cfg = configs[status] || { icon: AlertTriangle, className: 'bg-gray-500/10 text-gray-400' };
  const Icon = cfg.icon;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.className}`}>
      <Icon className="h-3 w-3" /> {status}
    </span>
  );
};

export default function SubmissionsPage() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [detail, setDetail] = useState<Submission | null>(null);

  // Track the in-flight controller so we can abort on filter change / unmount.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    setError('');
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const typeParam = filter !== 'all' ? `?type=${filter}` : '';
      const res = await apiFetch(
        `/api/accounting/sars/sars-submissions${typeParam}`,
        { credentials: 'include', signal: controller.signal },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setSubmissions(json.data?.items || []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Distinguish timeout from a fresh load preempting this one. If
        // inFlight has been replaced, this abort came from the next load —
        // don't surface a timeout error in that case.
        if (inFlight.current === controller) {
          setError('Request timed out after 30 seconds. Click Retry to try again.');
        }
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load submissions');
      }
    } finally {
      window.clearTimeout(timer);
      if (inFlight.current === controller) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, [filter]);

  useEffect(() => {
    void load();
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [load]);

  const viewDetail = async (id: string) => {
    try {
      const res = await apiFetch('/api/accounting/sars/sars-submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id, action: 'get' }),
      });
      const json = await res.json();
      if (json.data) {
        setDetail(json.data);
      }
    } catch {
      // Fallback to local data
      const sub = submissions.find((s) => s.id === id);
      if (sub) setDetail(sub);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/accounting/sars"
              className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
            >
              <ChevronLeft className="h-5 w-5" />
            </Link>
            <div className="p-2 rounded-lg bg-purple-500/10">
              <FileText className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Submission History</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                All SARS eFiling submissions and their statuses
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm flex items-center justify-between gap-3">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => load()}
                className="px-3 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs font-medium"
              >
                Retry
              </button>
            </div>
          )}

          {/* Filter Tabs */}
          <div className="flex gap-1 bg-[var(--ff-bg-secondary)] rounded-lg p-1 w-fit border border-[var(--ff-border-light)]">
            {['all', 'VAT201', 'EMP201', 'EMP501', 'IRP5'].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  filter === f
                    ? 'bg-teal-600 text-white'
                    : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                }`}
              >
                {f === 'all' ? 'All' : f}
              </button>
            ))}
          </div>

          {/* Submissions Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">SARS Reference</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                      Loading submissions...
                    </td>
                  </tr>
                )}
                {!loading && submissions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      No submissions found. Generate a VAT201 or EMP201 to create your first submission.
                    </td>
                  </tr>
                )}
                {submissions.map((sub) => (
                  <tr
                    key={sub.id}
                    className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                  >
                    <td className="px-4 py-3">
                      <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-teal-500/10 text-teal-400">
                        {sub.formType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">
                      {formatDate(sub.periodStart)} — {formatDate(sub.periodEnd)}
                    </td>
                    <td className="px-4 py-3">{statusBadge(sub.status)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] font-mono text-xs">
                      {sub.submissionReference || '—'}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {sub.submittedAt ? formatDateTime(sub.submittedAt) : '—'}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {formatDate(sub.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => viewDetail(sub.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-teal-500 hover:text-teal-400 hover:bg-teal-500/10"
                      >
                        <Eye className="h-3 w-3" /> View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <SubmissionDetailModal detail={detail} onClose={() => setDetail(null)} />
      </div>
    </AppLayout>
  );
}
