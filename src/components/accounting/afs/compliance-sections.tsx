// pages/accounting/afs/[documentId]/compliance-sections.tsx
// Sub-components for the compliance page — extracted to keep compliance.tsx under 300 lines.

import { CheckCircle, XCircle, AlertTriangle, Info, Clock, Bell, X } from 'lucide-react';
import type { ComplianceIssue, ComplianceResult, CipcFilingGuide, AfsComplianceAlert } from '@/modules/accounting/services/afs/afsTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

export function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

export function ScoreRing({ score }: { score: number }) {
  const colour = score >= 80 ? 'text-green-600' : score >= 50 ? 'text-amber-500' : 'text-red-600';
  return (
    <div className={`text-5xl font-black ${colour}`}>
      {score}<span className="text-2xl font-semibold text-gray-600 dark:text-gray-400">/100</span>
    </div>
  );
}

export function SeverityIcon({ severity }: { severity: ComplianceIssue['severity'] }) {
  if (severity === 'blocker') return <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />;
  if (severity === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />;
  return <Info className="w-4 h-4 text-blue-400 flex-shrink-0" />;
}

export function SeverityBadge({ severity }: { severity: ComplianceIssue['severity'] }) {
  const cls = severity === 'blocker' ? 'bg-red-100 text-red-700' : severity === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-600';
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${cls}`}>{severity}</span>;
}

// ── IssueList ─────────────────────────────────────────────────────────────────

export function IssueList({ result }: { result: ComplianceResult }) {
  const allIssues = [
    ...result.issues.filter(i => i.severity === 'blocker'),
    ...result.issues.filter(i => i.severity === 'warning'),
    ...result.issues.filter(i => i.severity === 'info'),
  ];
  if (allIssues.length === 0) {
    return (
      <div className="flex items-center gap-2 text-green-700 bg-green-50 rounded-lg px-4 py-3">
        <CheckCircle className="w-5 h-5" />
        <span className="text-sm font-semibold">All checks passed</span>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {allIssues.map(issue => (
        <div key={issue.checkId} className="flex items-start gap-3 border border-gray-100 rounded-lg px-4 py-3 bg-gray-50">
          <SeverityIcon severity={issue.severity} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <SeverityBadge severity={issue.severity} />
              <span className="text-xs text-gray-600 dark:text-gray-400 font-mono">{issue.checkId}</span>
            </div>
            <p className="text-sm text-gray-800 mt-1">{issue.message}</p>
            {issue.detail && <p className="text-xs text-gray-500 mt-0.5">{issue.detail}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── CipcGuideSection ──────────────────────────────────────────────────────────

export function CipcGuideSection({
  guide,
  onToggleSubmitted,
  togglingSubmitted,
}: {
  guide: CipcFilingGuide;
  onToggleSubmitted?: (submitted: boolean) => void;
  togglingSubmitted?: boolean;
}) {
  const days = daysUntil(guide.filingDeadline);
  const deadlineColour = days <= 14 ? 'text-red-600' : days <= 30 ? 'text-amber-600' : 'text-gray-900';
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Clock className="w-5 h-5 text-indigo-600" />
        <h2 className="text-lg font-bold text-gray-900">CIPC Filing Guide</h2>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
        <div><p className="text-gray-500">Company</p><p className="font-semibold text-gray-900">{guide.companyName}</p></div>
        <div><p className="text-gray-500">Registration</p><p className="font-semibold text-gray-900">{guide.registrationNumber ?? 'N/A'}</p></div>
        <div><p className="text-gray-500">Year End</p><p className="font-semibold text-gray-900">{guide.yearEnd}</p></div>
        <div>
          <p className="text-gray-500">Filing Deadline</p>
          <p className={`font-bold ${deadlineColour}`}>
            {guide.filingDeadline}
            <span className="text-xs font-normal text-gray-500 ml-1">({days} days)</span>
          </p>
        </div>
      </div>
      <div className="mb-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Required Filings</p>
        <ul className="space-y-1">
          {guide.requiredFilings.map(f => (
            <li key={f} className="text-sm text-gray-800 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />{f}
            </li>
          ))}
        </ul>
      </div>
      <div className="mb-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Documents Checklist</p>
        <div className="space-y-2">
          {guide.documentsReady.map(item => {
            const isCipcSubmission = item.label === 'CIPC annual return submitted';
            return (
              <div key={item.label} className="flex items-start gap-3">
                {isCipcSubmission && onToggleSubmitted ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={item.ready}
                    disabled={togglingSubmitted}
                    onClick={() => onToggleSubmitted(!item.ready)}
                    title={item.ready ? 'Mark as not submitted' : 'Mark as submitted'}
                    className="flex-shrink-0 mt-0.5 disabled:opacity-50"
                  >
                    {item.ready
                      ? <CheckCircle className="w-4 h-4 text-green-600" />
                      : <XCircle className="w-4 h-4 text-gray-700 dark:text-gray-300" />}
                  </button>
                ) : item.ready
                  ? <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                  : <XCircle className="w-4 h-4 text-gray-700 dark:text-gray-300 flex-shrink-0 mt-0.5" />}
                <div>
                  <p className="text-sm text-gray-800">{item.label}</p>
                  {item.detail && <p className="text-xs text-gray-600 dark:text-gray-400">{item.detail}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3 text-sm text-indigo-800">
        <span className="font-semibold">Next step: </span>{guide.nextStep}
      </div>
    </section>
  );
}

// ── AlertsSection ─────────────────────────────────────────────────────────────

export function AlertsSection({
  alerts,
  onDismiss,
}: {
  alerts: AfsComplianceAlert[];
  onDismiss: (id: string) => void;
}) {
  if (alerts.length === 0) return null;
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Bell className="w-5 h-5 text-indigo-600" />
        <h2 className="text-lg font-bold text-gray-900">Active Alerts</h2>
        <span className="ml-auto text-xs font-semibold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{alerts.length}</span>
      </div>
      <div className="space-y-3">
        {alerts.map(alert => (
          <div key={alert.id} className="flex items-start gap-3 border border-amber-200 bg-amber-50 rounded-lg px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-900">{alert.message}</p>
              {alert.detail && <p className="text-xs text-amber-700 mt-0.5">{alert.detail}</p>}
              <p className="text-xs text-amber-500 mt-1">{new Date(alert.firedAt).toLocaleDateString('en-ZA')}</p>
            </div>
            <button onClick={() => onDismiss(alert.id)} className="text-amber-500 hover:text-amber-700 flex-shrink-0" title="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
