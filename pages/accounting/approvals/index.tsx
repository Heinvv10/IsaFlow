/**
 * Approval Workflows — Manage rules and pending approval requests
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Shield, CheckCircle2, XCircle, Loader2, AlertCircle,
} from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { ApprovalEnforcementPanel } from '@/components/accounting/approvals/ApprovalEnforcementPanel';
import { approvalDocumentHref } from '@/components/accounting/approvals/approvalDocumentHref';
import { ApprovalRulesTab } from '@/components/accounting/approvals/ApprovalRulesTab';
import {
  DOC_TYPE_LABELS, formatCurrency, type ApprovalRuleRow as ApprovalRule,
} from '@/components/accounting/approvals/approvalRuleDisplay';
import { formatSaDateValue } from '@/lib/saDateParser';

interface ApprovalRequest {
  id: string;
  ruleName?: string;
  documentType: string;
  documentId: string;
  documentReference: string | null;
  amount: number | null;
  /** What the request vouches for (R-035); approve must send it back as expectedDigest. */
  documentDigest: string | null;
  status: string;
  requestedByName?: string;
  requestedAt: string;
  decidedByName?: string;
  decidedAt: string | null;
  decisionNotes: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-500',
  approved: 'bg-teal-500/20 text-teal-500',
  rejected: 'bg-red-500/20 text-red-500',
  cancelled: 'bg-gray-500/20 text-gray-500',
};

export default function ApprovalsPage() {
  const [tab, setTab] = useState<'pending' | 'rules' | 'history'>('pending');
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  // The role withAuth resolved for this company (the one the rule guards rank),
  // and whether the rules list is current — the Enforce panel's "no active rule"
  // note must not speak from a list that failed to load.
  const [actorRole, setActorRole] = useState<string | null>(null);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  // Every rules load takes a number; only the latest may set the list, so a slow
  // reload from an earlier write cannot overwrite a newer one (review round 1).
  const rulesSeq = useRef(0);
  // The same for the page's own load (requests, its error and the spinner): a
  // slow load from an earlier tab or decision must not land over a newer one.
  const loadSeq = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deciding, setDeciding] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    const load = ++loadSeq.current;
    const seq = ++rulesSeq.current;
    try {
      const [reqRes, rulesRes] = await Promise.all([
        apiFetch(tab === 'pending' ? '/api/accounting/approval-requests?status=pending' : '/api/accounting/approval-requests'),
        apiFetch('/api/accounting/approval-rules'),
      ]);
      await assertOk(reqRes, 'Could not load the approvals - try again');
      await assertOk(rulesRes, 'Could not load the approval rules - try again');
      const reqJson = await reqRes.json();
      const rulesJson = await rulesRes.json();
      if (load === loadSeq.current) setRequests(reqJson.data?.items ?? []);
      if (seq === rulesSeq.current) {
        setRules(rulesJson.data?.items ?? []);
        setActorRole(typeof rulesJson.data?.actorRole === 'string' ? rulesJson.data.actorRole : null);
        setRulesLoaded(true);
      }
    } catch (err) {
      if (seq === rulesSeq.current) { setRules([]); setActorRole(null); setRulesLoaded(false); }
      if (load === loadSeq.current) {
        setRequests([]);
        setError(apiErrorMessage(err, 'Could not load the approvals - try again'));
      }
    } finally {
      if (load === loadSeq.current) setLoading(false);
    }
  }, [tab]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleDecision = async (req: ApprovalRequest, action: 'approve' | 'reject') => {
    const requestId = req.id;
    setDeciding(requestId);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/approval-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Approving vouches for the content this row showed: the API refuses an
        // approve that does not name it (400), or names a stale one (409).
        body: JSON.stringify(action === 'approve' && req.documentDigest
          ? { action, requestId, expectedDigest: req.documentDigest }
          : { action, requestId }),
      });
      // A 403 here is a segregation-of-duties refusal; assertOk surfaces the reason it carries.
      await assertOk(res, 'Could not process the decision - try again');
      await fetchData();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not process the decision - try again'));
    } finally {
      setDeciding(null);
    }
  };

  // After a rule write: reload the rules alone, without the page spinner, so the
  // Rules tab (and a starter result it is showing) stays mounted. A failed reload
  // clears the rows it could not refresh (they may name a rule just deleted), and
  // the tab says they could not be loaded rather than that there are none.
  const refreshRules = useCallback(async () => {
    const seq = ++rulesSeq.current;
    try {
      const res = await apiFetch('/api/accounting/approval-rules');
      await assertOk(res, 'Could not load the approval rules - try again');
      const json = await res.json();
      if (seq !== rulesSeq.current) return;
      setRules(json.data?.items ?? []);
      setActorRole(typeof json.data?.actorRole === 'string' ? json.data.actorRole : null);
      setRulesLoaded(true);
    } catch (err) {
      if (seq !== rulesSeq.current) return;
      setRules([]); setActorRole(null); setRulesLoaded(false);
      setError(apiErrorMessage(err, 'Could not load the approval rules - try again'));
    }
  }, []);

  const pendingCount = requests.filter(r => r.status === 'pending').length;

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6">
        <PageHeader
          icon={Shield}
          title="Approvals"
          subtitle="Review and manage approval workflows"
          actions={pendingCount > 0 ? (
            <div className="bg-amber-500/20 text-amber-700 dark:text-amber-400 px-3 py-1 rounded-full text-sm font-medium">
              {pendingCount} pending
            </div>
          ) : undefined}
        />

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[var(--ff-border-primary)]">
          {(['pending', 'history', 'rules'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t
                  ? 'border-teal-500 text-teal-500'
                  : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
              }`}
            >
              {t === 'pending' ? `Pending (${pendingCount})` : t}
            </button>
          ))}
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-500 text-sm">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}

        {/* R-149: mounted outside the `loading` branch — the switch's own preview
            GET fires on mount, and gating it on `loading` unmounted/remounted it
            (and refired the GET) every time the shared rules/requests fetch
            re-ran after the tab switch, doubling the request for one visit. */}
        {tab === 'rules' && (
          <ApprovalEnforcementPanel
            activeRuleTypes={rulesLoaded ? rules.filter(r => r.isActive).map(r => r.documentType) : undefined}
          />
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        ) : tab === 'rules' ? (
          /* Rules Tab — R-035: rules the Enforce switch (above) governs */
          <ApprovalRulesTab rules={rules} loaded={rulesLoaded} actorRole={actorRole} onChanged={refreshRules} />
        ) : (
          /* Pending / History Tab */
          <div className="space-y-3">
            {requests.length === 0 ? (
              <div className="text-center py-12 text-[var(--ff-text-secondary)]">
                {tab === 'pending' ? 'No pending approvals' : 'No approval history'}
              </div>
            ) : requests.filter(r => tab === 'pending' ? r.status === 'pending' : true).map(req => (
              <div
                key={req.id}
                className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-4 flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[req.status] || ''}`}>
                      {req.status}
                    </span>
                    <span className="text-xs text-[var(--ff-text-tertiary)]">
                      {DOC_TYPE_LABELS[req.documentType] || req.documentType}
                    </span>
                    {req.ruleName && (
                      <span className="text-xs text-[var(--ff-text-tertiary)]">• {req.ruleName}</span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-[var(--ff-text-primary)]">
                    {(() => {
                      // R-035: the document the request is for, linked where it has a page.
                      const label = req.documentReference || req.documentId.slice(0, 8);
                      const href = approvalDocumentHref(req.documentType, req.documentId);
                      return href ? <Link href={href} className="hover:text-teal-500 hover:underline">{label}</Link> : label;
                    })()}
                    {req.amount != null && <span className="ml-2 text-teal-500">{formatCurrency(req.amount)}</span>}
                  </p>
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                    Requested by {req.requestedByName || 'Unknown'} • {formatSaDateValue(req.requestedAt)}
                    {req.decidedByName && ` • Decided by ${req.decidedByName}`}
                  </p>
                </div>

                {req.status === 'pending' && (
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => void handleDecision(req, 'approve')}
                      disabled={deciding === req.id}
                      className="flex items-center gap-1 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" /> Approve
                    </button>
                    <button
                      onClick={() => void handleDecision(req, 'reject')}
                      disabled={deciding === req.id}
                      className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      <XCircle className="h-4 w-4" /> Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
