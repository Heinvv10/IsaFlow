/**
 * SARS Compliance Dashboard
 * Overview of upcoming deadlines, quick links, and recent submissions.
 */

import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  Building2, FileText, Calendar,
  CheckCircle2, AlertTriangle, XCircle,
  Loader2, ChevronRight,
} from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { ComplianceCalendarTable } from '@/components/accounting/sars/ComplianceCalendarTable';
import { statusBadge } from '@/components/accounting/sars/sarsStatusBadge';
import { useSarsOverview, calendarCounts } from '@/components/accounting/sars/useSarsOverview';

export default function SARSDashboard() {
  const { isRegistered } = useVatRegistration();
  const { events, submissions, marksUnavailable, submissionsUnavailable, loading, error, refresh } = useSarsOverview();
  const { overdue: overdueCount, pending: pendingCount, completed: completedCount } = calendarCounts(events);

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
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Compliance Calendar</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                SARS eFiling overview: VAT201, EMP201, and filing tracking
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
                  label="Filings"
                  value={submissions.length}
                  color="teal"
                  icon={<FileText className="h-5 w-5" />}
                />
              </div>

              {/* Quick Actions */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* A non-vendor has no VAT201 to generate. */}
                {isRegistered && (
                  <QuickAction
                    href="/accounting/sars/vat201"
                    title="Generate VAT201"
                    description="VAT return for the company's filing period"
                    icon={<FileText className="h-5 w-5 text-teal-500" />}
                  />
                )}
                <QuickAction
                  href="/accounting/sars/emp201"
                  title="Generate EMP201"
                  description="Monthly PAYE, UIF and SDL return"
                  icon={<FileText className="h-5 w-5 text-blue-600 dark:text-blue-400" />}
                />
                <QuickAction
                  href="/accounting/sars/submissions"
                  title="Filing History"
                  description="View all past SARS filing records"
                  icon={<Calendar className="h-5 w-5 text-purple-500" />}
                />
              </div>

              {/* Compliance Calendar */}
              <ComplianceCalendarTable events={events} marksUnavailable={marksUnavailable} submissionsUnavailable={submissionsUnavailable} onChanged={refresh} />

              {/* Recent Submissions */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                <div className="px-4 py-3 border-b border-[var(--ff-border-light)] flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
                    <FileText className="h-5 w-5 text-teal-500" />
                    Recent Filings
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
                            No filing records yet. Generate a VAT201 or EMP201 to get started.
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
