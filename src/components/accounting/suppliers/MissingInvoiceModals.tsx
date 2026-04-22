/**
 * MissingInvoiceModals — Chase / Resolve / Dismiss modals for PRD-05 Phase 6
 */

import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { X } from 'lucide-react';

export interface ExpectedAlert {
  id: string; companyId: string; supplierId: string;
  supplierName: string; supplierEmail: string | null;
  expectationId: string | null;
  expectedBy: string; expectedAmount: number | null;
  daysOverdue: number;
  status: 'pending' | 'chased' | 'resolved' | 'dismissed';
  chasedAt: string | null;
  chaseMethod: 'email' | 'whatsapp' | null;
  chaseToAddress: string | null;
  resolvedInvoiceId: string | null;
  resolvedAt: string | null;
  dismissedReason: string | null;
}

const fmtDate = (s: string | Date | null) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
};
const fmtZAR = (n: number | null) =>
  n == null ? '—' : 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function buildPreview(a: ExpectedAlert) {
  const subject = `Invoice reminder — ${a.supplierName}`;
  const amount = a.expectedAmount != null ? fmtZAR(a.expectedAmount) : 'the expected amount';
  const body =
    `Dear ${a.supplierName},\n\n` +
    `We are following up regarding an invoice we expected to receive by ${fmtDate(a.expectedBy)}` +
    (a.expectedAmount != null ? ` for ${amount}` : '') +
    `.\n\nCould you please confirm whether this invoice has been issued, and if so, forward a copy for our records?\n\nKind regards`;
  return { subject, body };
}

interface Props {
  chaseAlert: ExpectedAlert | null;
  resolveAlert: ExpectedAlert | null;
  dismissAlert: ExpectedAlert | null;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function MissingInvoiceModals({ chaseAlert, resolveAlert, dismissAlert, onClose, onSuccess, onError }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [dismissReason, setDismissReason] = useState('');

  const wrap = useCallback(async (fn: () => Promise<void>) => {
    setSubmitting(true);
    try { await fn(); } finally { setSubmitting(false); }
  }, []);

  const doChase = () => wrap(async () => {
    if (!chaseAlert) return;
    const res = await apiFetch(`/api/accounting/expected-invoice-alerts/${chaseAlert.id}/chase`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const json = await res.json() as { error?: string };
    if (!res.ok) { onError(json.error ?? 'Chase failed'); return; }
    onSuccess('Chase email queued successfully'); onClose();
  });

  const doResolve = () => wrap(async () => {
    if (!resolveAlert) return;
    const res = await apiFetch(`/api/accounting/expected-invoice-alerts/${resolveAlert.id}/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Manually resolved by user' }),
    });
    const json = await res.json() as { error?: string };
    if (!res.ok) { onError(json.error ?? 'Resolve failed'); return; }
    onSuccess('Alert marked resolved'); onClose();
  });

  const doDismiss = () => wrap(async () => {
    if (!dismissAlert || !dismissReason.trim()) return;
    const res = await apiFetch(`/api/accounting/expected-invoice-alerts/${dismissAlert.id}/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: dismissReason.trim() }),
    });
    const json = await res.json() as { error?: string };
    if (!res.ok) { onError(json.error ?? 'Dismiss failed'); return; }
    onSuccess('Alert dismissed'); setDismissReason(''); onClose();
  });

  const Overlay = ({ children }: { children: React.ReactNode }) => (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-lg">
        {children}
      </div>
    </div>
  );

  const ModalHeader = ({ title }: { title: string }) => (
    <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--ff-border-light)]">
      <h2 className="font-semibold text-[var(--ff-text-primary)]">{title}</h2>
      <button onClick={onClose} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"><X className="h-5 w-5" /></button>
    </div>
  );

  if (chaseAlert) {
    const { subject, body } = buildPreview(chaseAlert);
    return (
      <Overlay>
        <ModalHeader title="Chase email preview" />
        <div className="px-5 py-4 space-y-3">
          <div><p className="text-xs text-[var(--ff-text-tertiary)] mb-1">To</p><p className="text-sm text-[var(--ff-text-primary)]">{chaseAlert.supplierEmail}</p></div>
          <div><p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Subject</p><p className="text-sm text-[var(--ff-text-primary)]">{subject}</p></div>
          <div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Body</p>
            <pre className="text-xs text-[var(--ff-text-secondary)] whitespace-pre-wrap bg-[var(--ff-bg-primary)] rounded-lg p-3 border border-[var(--ff-border-light)] font-sans leading-relaxed">{body}</pre>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-[var(--ff-border-light)] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
          <button onClick={doChase} disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white transition-colors">
            {submitting ? 'Sending...' : 'Send chase'}
          </button>
        </div>
      </Overlay>
    );
  }

  if (resolveAlert) {
    return (
      <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
        <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h2 className="font-semibold text-[var(--ff-text-primary)] mb-2">Resolve manually?</h2>
          <p className="text-sm text-[var(--ff-text-secondary)] mb-4">This marks the alert resolved without linking an invoice. No journal entry is created.</p>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
            <button onClick={doResolve} disabled={submitting}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white transition-colors">
              {submitting ? 'Resolving...' : 'Mark resolved'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (dismissAlert) {
    return (
      <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
        <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h2 className="font-semibold text-[var(--ff-text-primary)] mb-2">Dismiss alert</h2>
          <p className="text-sm text-[var(--ff-text-secondary)] mb-3">Provide a reason for dismissal:</p>
          <textarea value={dismissReason} onChange={e => setDismissReason(e.target.value)} rows={3}
            placeholder="e.g. Invoice received outside system, duplicate expectation..."
            className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] focus:outline-none focus:border-teal-500/50 resize-none mb-4"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => { setDismissReason(''); onClose(); }} className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
            <button onClick={doDismiss} disabled={submitting || !dismissReason.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white transition-colors">
              {submitting ? 'Dismissing...' : 'Dismiss'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
