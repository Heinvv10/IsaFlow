/**
 * Approval Workflows — Manage rules and pending approval requests
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Shield, CheckCircle2, XCircle, Clock, Loader2, Plus, Trash2, AlertCircle,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

function formatCurrency(amount: number): string {
  return 'R ' + Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface ApprovalRule {
  id: string;
  name: string;
  documentType: string;
  conditionField: string;
  conditionOperator: string;
  conditionValue: number;
  approverRole: string;
  isActive: boolean;
}

interface ApprovalRequest {
  id: string;
  ruleName?: string;
  documentType: string;
  documentId: string;
  documentReference: string | null;
  amount: number | null;
  status: string;
  requestedByName?: string;
  requestedAt: string;
  decidedByName?: string;
  decidedAt: string | null;
  decisionNotes: string | null;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  customer_invoice: 'Customer Invoice',
  supplier_invoice: 'Supplier Invoice',
  payment: 'Payment',
  journal_entry: 'Journal Entry',
  credit_note: 'Credit Note',
};

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deciding, setDeciding] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [reqRes, rulesRes] = await Promise.all([
        apiFetch(tab === 'pending' ? '/api/accounting/approval-requests?status=pending' : '/api/accounting/approval-requests'),
        apiFetch('/api/accounting/approval-rules'),
      ]);
      if (!reqRes.ok || !rulesRes.ok) throw new Error('Failed to load');
      const reqJson = await reqRes.json();
      const rulesJson = await rulesRes.json();
      setRequests(reqJson.data?.items ?? []);
      setRules(rulesJson.data?.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleDecision = async (requestId: string, action: 'approve' | 'reject') => {
    setDeciding(requestId);
    try {
      const res = await apiFetch('/api/accounting/approval-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, requestId }),
      });
      if (!res.ok) throw new Error('Failed');
      await fetchData();
    } catch {
      setError('Failed to process decision');
    } finally {
      setDeciding(null);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await apiFetch(`/api/accounting/approval-rules?id=${ruleId}`, { method: 'DELETE' });
      await fetchData();
    } catch {
      setError('Failed to delete rule');
    }
  };

  const pendingCount = requests.filter(r => r.status === 'pending').length;

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Shield className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Approvals</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Review and manage approval workflows
              </p>
            </div>
          </div>
          {pendingCount > 0 && (
            <div className="bg-amber-500/20 text-amber-500 px-3 py-1 rounded-full text-sm font-medium">
              {pendingCount} pending
            </div>
          )}
        </div>

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

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        ) : tab === 'rules' ? (
          /* Rules Tab */
          <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--ff-bg-secondary)]">
                  <th className="text-left px-4 py-3 font-medium text-[var(--ff-text-secondary)]">Rule Name</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--ff-text-secondary)]">Document Type</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--ff-text-secondary)]">Condition</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--ff-text-secondary)]">Approver</th>
                  <th className="text-center px-4 py-3 font-medium text-[var(--ff-text-secondary)]">Active</th>
                  <th className="text-center px-4 py-3 font-medium text-[var(--ff-text-secondary)]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border-primary)]">
                {rules.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-secondary)]">No approval rules configured</td></tr>
                ) : rules.map(rule => (
                  <tr key={rule.id} className="hover:bg-[var(--ff-bg-hover)]">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{rule.name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{DOC_TYPE_LABELS[rule.documentType] || rule.documentType}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {rule.conditionOperator === 'any' ? 'All documents' : `${rule.conditionField} > ${formatCurrency(rule.conditionValue)}`}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">{rule.approverRole}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block w-2 h-2 rounded-full ${rule.isActive ? 'bg-teal-500' : 'bg-gray-400'}`} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button onClick={() => void handleDeleteRule(rule.id)} className="text-red-400 hover:text-red-500">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                    {req.documentReference || req.documentId.slice(0, 8)}
                    {req.amount != null && <span className="ml-2 text-teal-500">{formatCurrency(req.amount)}</span>}
                  </p>
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                    Requested by {req.requestedByName || 'Unknown'} • {new Date(req.requestedAt).toLocaleDateString('en-ZA')}
                    {req.decidedByName && ` • Decided by ${req.decidedByName}`}
                  </p>
                </div>

                {req.status === 'pending' && (
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => void handleDecision(req.id, 'approve')}
                      disabled={deciding === req.id}
                      className="flex items-center gap-1 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" /> Approve
                    </button>
                    <button
                      onClick={() => void handleDecision(req.id, 'reject')}
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
