/**
 * R-035: the approval state of an unposted document, derived by the server
 * (the detail GET's `approval`), and the "Submit for approval" action where
 * the document cannot post yet. Renders nothing when no enforced rule governs
 * it. Generalised from the PR2 supplier-invoice panel (PR3) so every
 * enforceable type shows the same thing; `noun` is what the page calls the
 * document ('bill', 'credit note').
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

export interface DocumentApprovalPanelProps {
  /** The approval document type the request is raised as, e.g. 'supplier_invoice'. */
  documentType: string;
  documentId: string;
  noun: string;
  approval: DocumentApprovalState | null | undefined;
  onChanged: () => Promise<void> | void;
  /** What the approval lets happen: a document is posted (default), a payment or batch is paid (R-035 PR5). */
  action?: 'post' | 'pay';
}

const withArticle = (role: string) => `${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`;

/** True while the document may not post: the page hides its Approve / Post action (the panel offers Submit). */
export const isApprovalHeld = (approval: DocumentApprovalState | null | undefined): boolean =>
  approval?.state === 'required' || approval?.state === 'pending' || approval?.state === 'stale';

const WORDS = {
  post: { passive: 'posted', gerund: 'posting', verb: 'post' },
  pay: { passive: 'paid', gerund: 'paying', verb: 'pay' },
} as const;

export function DocumentApprovalPanel({ documentType, documentId, noun, approval, onChanged, action = 'post' }: DocumentApprovalPanelProps) {
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
        body: JSON.stringify({ action: 'request', documentType, documentId }),
      });
      await assertOk(res, `Could not submit the ${noun} for approval - try again`);
    } catch (err) {
      setError(apiErrorMessage(err, `Could not submit the ${noun} for approval - try again`));
      setSubmitting(false);
      return;
    }
    try {
      await onChanged();
    } catch {
      setError(`The ${noun} was submitted for approval, but the page could not refresh - reload to see its status`);
    } finally {
      setSubmitting(false);
    }
  };

  const words = WORDS[action];
  const message = {
    required: `This ${noun} needs ${role} approval before it can be ${words.passive}${rule}.`,
    stale: `This ${noun} changed after it was approved. Submit it for approval again before ${words.gerund}.`,
    pending: `Awaiting approval by ${withArticle(role)}${rule}.`,
    approved: `Approved by ${withArticle(role)} — ready to ${words.verb}.`,
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
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Submit for approval
        </button>
      )}
      {error && <p className="w-full text-red-400">{error}</p>}
    </div>
  );
}
