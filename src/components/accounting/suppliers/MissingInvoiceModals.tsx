/**
 * MissingInvoiceModals — Chase / Resolve / Dismiss modals for PRD-05 Phase 6 + Phase 8
 */

import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { X, Mail, MessageSquare } from 'lucide-react';

export interface ExpectedAlert {
  id: string; companyId: string; supplierId: string;
  supplierName: string; supplierEmail: string | null;
  supplierWhatsappNumber?: string | null;
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

type ChaseMethod = 'email' | 'whatsapp';

const fmtDate = (s: string | Date | null) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
};
const fmtZAR = (n: number | null) =>
  n == null ? '—' : 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function buildEmailPreview(a: ExpectedAlert) {
  const subject = `Invoice reminder — ${a.supplierName}`;
  const amount = a.expectedAmount != null ? fmtZAR(a.expectedAmount) : 'the expected amount';
  const body =
    `Dear ${a.supplierName},\n\n` +
    `We are following up regarding an invoice we expected to receive by ${fmtDate(a.expectedBy)}` +
    (a.expectedAmount != null ? ` for ${amount}` : '') +
    `.\n\nCould you please confirm whether this invoice has been issued, and if so, forward a copy for our records?\n\nKind regards`;
  return { subject, body };
}

function buildWaPreview(a: ExpectedAlert) {
  const amount = a.expectedAmount != null ? fmtZAR(a.expectedAmount) : 'the expected amount';
  return `Hi ${a.supplierName}, we're following up on an invoice we expected by ${fmtDate(a.expectedBy)}` +
    (a.expectedAmount != null ? ` for ${amount}` : '') +
    `. Could you please confirm if this has been issued? Thank you.`;
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
  const [chaseTab, setChaseTab] = useState<ChaseMethod>('email');

  const wrap = useCallback(async (fn: () => Promise<void>) => {
    setSubmitting(true);
    try { await fn(); } finally { setSubmitting(false); }
  }, []);

  const doChase = (method: ChaseMethod) => wrap(async () => {
    if (!chaseAlert) return;
    const res = await apiFetch(`/api/accounting/expected-invoice-alerts/${chaseAlert.id}/chase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method }),
    });
    const json = await res.json() as { error?: string };
    if (!res.ok) { onError(json.error ?? 'Chase failed'); return; }
    onSuccess(method === 'whatsapp' ? 'WhatsApp chase queued' : 'Chase email queued successfully');
    onClose();
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
    const hasWa = Boolean(chaseAlert.supplierWhatsappNumber);
    const { subject, body: emailBody } = buildEmailPreview(chaseAlert);
    const waBody = buildWaPreview(chaseAlert);

    return (
      <Overlay>
        <ModalHeader title="Chase preview" />

        {/* Method tabs */}
        <div className="flex border-b border-[var(--ff-border-light)] px-5 gap-1">
          {(['email', 'whatsapp'] as ChaseMethod[]).map(tab => (
            <button key={tab} onClick={() => setChaseTab(tab)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ${
                chaseTab === tab
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
              }`}>
              {tab === 'email' ? <Mail className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
              {tab}
            </button>
          ))}
        </div>

        <div className="px-5 py-4 space-y-3">
          {chaseTab === 'email' ? (
            <>
              <div><p className="text-xs text-[var(--ff-text-tertiary)] mb-1">To</p><p className="text-sm text-[var(--ff-text-primary)]">{chaseAlert.supplierEmail ?? '—'}</p></div>
              <div><p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Subject</p><p className="text-sm text-[var(--ff-text-primary)]">{subject}</p></div>
              <div>
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Body</p>
                <pre className="text-xs text-[var(--ff-text-secondary)] whitespace-pre-wrap bg-[var(--ff-bg-primary)] rounded-lg p-3 border border-[var(--ff-border-light)] font-sans leading-relaxed">{emailBody}</pre>
              </div>
            </>
          ) : (
            <>
              <div>
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">To</p>
                <p className="text-sm text-[var(--ff-text-primary)]">
                  {chaseAlert.supplierWhatsappNumber ?? <span className="text-amber-400 text-xs">No WhatsApp number on file</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Message</p>
                <pre className="text-xs text-[var(--ff-text-secondary)] whitespace-pre-wrap bg-[var(--ff-bg-primary)] rounded-lg p-3 border border-[var(--ff-border-light)] font-sans leading-relaxed">{waBody}</pre>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--ff-border-light)] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>

          {chaseTab === 'email' ? (
            <button onClick={() => doChase('email')} disabled={submitting || !chaseAlert.supplierEmail}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white transition-colors">
              {submitting ? 'Sending...' : 'Send email'}
            </button>
          ) : (
            <div className="relative group/tip">
              <button onClick={() => doChase('whatsapp')} disabled={submitting || !hasWa}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white transition-colors">
                {submitting ? 'Sending...' : 'Send WhatsApp chase'}
              </button>
              {!hasWa && (
                <span className="pointer-events-none absolute bottom-full right-0 mb-1.5 px-2 py-1 rounded text-xs bg-gray-900 text-gray-200 whitespace-nowrap opacity-0 group-hover/tip:opacity-100 transition-opacity z-10">
                  No WhatsApp number on file
                </span>
              )}
            </div>
          )}
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
