/** Discard the F draft receipt an accepted payment message names (intercompany F, (k) Q1): a reason is required; the message is open again. */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { PaymentTarget } from '@/modules/accounting/services/intercompany/paymentInboxTypes';

interface Props {
  open: boolean;
  messageId: string;
  target: PaymentTarget | null;
  onClose: () => void;
  onDone: (msg: string) => void;
  /** round 1 (LOW-3): the draft's message is missing, so nothing is reopened */
  orphan?: boolean;
}

export function PaymentDiscardModal({ open, messageId, target, onClose, onDone, orphan = false }: Props) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setReason(''); setError(''); }, [open, messageId]);
  if (!open || !target) return null;

  async function submit() {
    if (busy || !target) return;
    if (reason.trim() === '') { setError('Say why you are discarding the draft.'); return; }
    setBusy(true);
    setError('');
    try {
      await apiJson(`/api/accounting/intercompany/payments/${messageId}/discard-draft`, {
        method: 'POST', body: JSON.stringify({ paymentId: target.paymentId, reason: reason.trim() }),
      }, 'Could not discard the draft - try again');
      onDone(`Discarded draft ${target.paymentNumber}. The payment is open again.`);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not discard the draft - try again'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => undefined : onClose} title={`Discard draft ${target.paymentNumber}`} size="md">
      <Modal.Body>
        <form id="ic-discard-form" className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <p className="text-sm text-ink-muted">{orphan
            ? 'The draft receipt is cancelled (nothing was posted from it). Its intercompany payment message is missing, so nothing else changes.'
            : 'The draft receipt is cancelled (nothing was posted from it) and the payment message is open again, to match or draft anew.'}</p>
          <div>
            <label htmlFor="ic-discard-reason" className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Reason</label>
            <textarea id="ic-discard-reason" rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} className="ff-input w-full text-sm" />
          </div>
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </form>
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onClose} disabled={busy} className="px-3 py-2 text-sm rounded-lg border border-line text-ink disabled:opacity-50">Cancel</button>
        <button type="submit" form="ic-discard-form" disabled={busy}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white disabled:opacity-50 inline-flex items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Discard the draft
        </button>
      </Modal.Footer>
    </Modal>
  );
}
