/**
 * R-035 PR2: the approval state of an unposted supplier invoice, derived by the
 * server (the detail GET's `approval`), and the "Submit for approval" action
 * where the bill cannot post yet. Renders nothing when no enforced rule governs
 * the bill.
 *
 * Submitting reuses POST /api/accounting/approval-requests { action: 'request' }.
 * apiFetch resolves on a 4xx (a Login-as session is refused 403), so the result
 * is read from res.ok and a refusal is shown, not swallowed.
 */
import { useState } from 'react';
import Link from 'next/link';
import { ShieldAlert, ShieldCheck, Clock, Send, Loader2 } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import type { DocumentApprovalState } from '@/modules/accounting/types/approval.types';

interface Props {
  invoiceId: string;
  approval: DocumentApprovalState | null | undefined;
  onChanged: () => Promise<void> | void;
}

const withArticle = (role: string) => `${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`;

export function SupplierInvoiceApprovalPanel({ invoiceId, approval, onChanged }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  if (!approval || approval.state === 'not_required') return null;

  const role = approval.requiredRole ?? 'approver';
  const rule = approval.ruleName ? ` (rule: ${approval.ruleName})` : '';
  const canSubmit = approval.state === 'required' || approval.state === 'stale';

  const submit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/approval-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request', documentType: 'supplier_invoice', documentId: invoiceId }),
      });
      await assertOk(res, 'Could not submit the bill for approval - try again');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not submit the bill for approval - try again'));
      setSubmitting(false);
      return;
    }
    try {
      await onChanged();
    } catch {
      setError('The bill was submitted for approval, but the page could not refresh - reload to see its status');
    } finally {
      setSubmitting(false);
    }
  };

  const message = {
    required: `This bill needs ${role} approval before it can be posted${rule}.`,
    stale: 'This bill changed after it was approved. Submit it for approval again before posting.',
    pending: `Awaiting approval by ${withArticle(role)}${rule}.`,
    approved: `Approved by ${withArticle(role)} — ready to post.`,
  }[approval.state];
  const tone = approval.state === 'approved'
    ? 'bg-teal-500/10 text-teal-500'
    : approval.state === 'pending' ? 'bg-blue-500/10 text-blue-400' : 'bg-amber-500/10 text-amber-500';
  const Icon = approval.state === 'approved' ? ShieldCheck : approval.state === 'pending' ? Clock : ShieldAlert;

  return (
    <div className={`mx-6 mt-4 flex flex-wrap items-center gap-3 p-3 rounded-lg text-sm ${tone}`}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {approval.state === 'pending' && (
        <Link href="/accounting/approvals" className="underline hover:no-underline">View approvals</Link>
      )}
      {canSubmit && (
        <button
          type="button"
          onClick={() => { void submit(); }}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-60"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Submit for approval
        </button>
      )}
      {error && <p className="w-full text-red-400">{error}</p>}
    </div>
  );
}
