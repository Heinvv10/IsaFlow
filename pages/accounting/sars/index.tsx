/**
 * SARS Compliance Dashboard
 * Overview of upcoming deadlines, quick links, and recent submissions.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  Building2, FileText, Calendar, Clock,
  CheckCircle2, AlertTriangle, XCircle,
  Loader2, ChevronRight,
} from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface ComplianceEvent {
  id?: string;
  eventType: string;
  dueDate: string;
  description: string;
  status: 'pending' | 'completed' | 'overdue';
  submissionId?: string;
}

interface Submission {
  id: string;
  formType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  submissionReference: string | null;
  submittedAt: string | null;
  createdAt: string;
}

const statusBadge = (status: string) => {
  switch (status) {
    case 'completed':
    case 'submitted':
    case 'accepted':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400">
          <CheckCircle2 className="h-3 w-3" /> {status}
        </span>
      );
    case 'overdue':
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400">
          <XCircle className="h-3 w-3" /> {status}
        </span>
      );
    case 'pending':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400">
          <Clock className="h-3 w-3" /> {status}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/10 text-gray-400">
          {status}
        </span>
      );
  }
};

const daysUntil = (d: string) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(d);
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
};

export default function SARSDashboard() {
  const [events, setEvents] = useState<ComplianceEvent[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [compRes, subRes] = await Promise.all([
        apiFetch('/api/accounting/sars/sars-compliance', { credentials: 'include' }),
        apiFetch('/api/accounting/sars/sars-submissions', { credentials: 'include' }),
      ]);
      const compJson = await compRes.json();
      const subJson = await subRes.json();
      setEvents(compJson.data?.events || []);
      setSubmissions(subJson.data?.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Filter upcoming events (next 90 days + overdue)
  const upcomingEvents = events.filter((e) => {
    const days = daysUntil(e.dueDate);
    return e.status === 'overdue' || (e.status === 'pending' && days <= 90);
  });

  const overdueCount = events.filter((e) => e.status === 'overdue').length;
  const pendingCount = upcomingEvents.filter((e) => e.status === 'pending').length;
  const completedCount = events.filter((e) => e.status === 'completed').length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Building2 className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">SARS eFiling</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Tax compliance dashboard — VAT201, EMP201, and submission tracking
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              <span className="ml-2 text-[var(--ff-text-secondary)]">Loading compliance data...</span>
            </div>
          ) : (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <SummaryCard
                  label="Overdue"
                  value={overdueCount}
                  color="red"
                  icon={<XCircle className="h-5 w-5" />}
                />
                <SummaryCard
                  label="Upcoming (90 days)"
                  value={pendingCount}
                  color="amber"
                  icon={<AlertTriangle className="h-5 w-5" />}
                />
                <SummaryCard
                  label="Completed"
                  value={completedCount}
                  color="emerald"
                  icon={<CheckCircle2 className="h-5 w-5" />}
                />
                <SummaryCard
                  label="Submissions"
                  value={submissions.length}
                  color="teal"
                  icon={<FileText className="h-5 w-5" />}
                />
              </div>

              {/* Quick Actions */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <QuickAction
                  href="/accounting/sars/vat201"
                  title="Generate VAT201"
                  description="VAT return for bi-monthly period"
                  icon={<FileText className="h-5 w-5 text-teal-500" />}
                />
                <QuickAction
                  href="/accounting/sars/emp201"
                  title="Generate EMP201"
                  description="Monthly PAYE, UIF and SDL return"
                  icon={<FileText className="h-5 w-5 text-blue-500" />}
                />
                <QuickAction
                  href="/accounting/sars/submissions"
                  title="Submission History"
                  description="View all past SARS submissions"
                  icon={<Calendar className="h-5 w-5 text-purple-500" />}
                />
              </div>

              {/* Compliance Calendar */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
                    <Calendar className="h-5 w-5 text-teal-500" />
                    Upcoming Deadlines
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                        <th className="px-4 py-3">Type</th>
                        <th className="px-4 py-3">Description</th>
                        <th className="px-4 py-3">Due Date</th>
                        <th className="px-4 py-3">Days</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upcomingEvents.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                            No upcoming deadlines in the next 90 days.
                          </td>
                        </tr>
                      )}
                      {upcomingEvents.map((evt, idx) => {
                        const days = daysUntil(evt.dueDate);
                        return (
                          <tr
                            key={`${evt.eventType}-${evt.dueDate}-${idx}`}
                            className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                          >
                            <td className="px-4 py-3">
                              <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-teal-500/10 text-teal-400">
                                {evt.eventType.replace('_DUE', '').replace('_', ' ')}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-[var(--ff-text-primary)]">{evt.description}</td>
                            <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatDate(evt.dueDate)}</td>
                            <td className="px-4 py-3">
                              <span className={`font-medium ${
                                days < 0 ? 'text-red-400' : days <= 14 ? 'text-amber-400' : 'text-[var(--ff-text-secondary)]'
                              }`}>
                                {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today' : `${days}d`}
                              </span>
                            </td>
                            <td className="px-4 py-3">{statusBadge(evt.status)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Recent Submissions */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                <div className="px-4 py-3 border-b border-[var(--ff-border-light)] flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
                    <FileText className="h-5 w-5 text-teal-500" />
                    Recent Submissions
                  </h2>
                  <Link
                    href="/accounting/sars/submissions"
                    className="text-sm text-teal-500 hover:text-teal-400 flex items-center gap-1"
                  >
                    View all <ChevronRight className="h-4 w-4" />
                  </Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                        <th className="px-4 py-3">Type</th>
                        <th className="px-4 py-3">Period</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Reference</th>
                        <th className="px-4 py-3">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {submissions.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                            No submissions yet. Generate a VAT201 or EMP201 to get started.
                          </td>
                        </tr>
                      )}
                      {submissions.slice(0, 10).map((sub) => (
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
                            {formatDate(sub.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function SummaryCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number;
  color: string;
  icon: React.ReactNode;
}) {
  const colorMap: Record<string, string> = {
    red: 'text-red-500 bg-red-500/10',
    amber: 'text-amber-500 bg-amber-500/10',
    emerald: 'text-emerald-500 bg-emerald-500/10',
    teal: 'text-teal-500 bg-teal-500/10',
  };
  const classes = colorMap[color] || colorMap.teal;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${classes}`}>{icon}</div>
        <div>
          <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{value}</p>
          <p className="text-xs text-[var(--ff-text-secondary)]">{label}</p>
        </div>
      </div>
    </div>
  );
}

function QuickAction({
  href,
  title,
  description,
  icon,
}: {
  href: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 hover:border-teal-500/30 transition-colors group"
    >
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-[var(--ff-bg-primary)]">{icon}</div>
        <div className="flex-1">
          <p className="font-medium text-[var(--ff-text-primary)] group-hover:text-teal-500 transition-colors">
            {title}
          </p>
          <p className="text-xs text-[var(--ff-text-secondary)]">{description}</p>
        </div>
        <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-500 transition-colors" />
      </div>
    </Link>
  );
}
