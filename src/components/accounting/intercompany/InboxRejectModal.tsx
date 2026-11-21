/** Reject an intercompany message: a reason is required, and the sender reads it. */
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { InboxItem } from '@/modules/accounting/services/intercompany/inboxTypes';

interface Props {
  item: InboxItem | null;
  onClose: () => void;
  onDone: (message: string) => void;
}

export function InboxRejectModal({ item, onClose, onDone }: Props) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // `busy` is state: a second submit in the same event batch still sees the enabled button. The ref is read at once.
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  // Another message, another reason: never carry one message's text (or its error) to the next.
  useEffect(() => { setReason(''); setError(''); }, [item?.id]);

  async function submit() {
    if (!item || submitting.current) return;
    if (reason.trim() === '') { setError('Say why you are rejecting it: the sender will read this.'); return; }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await apiJson(`/api/accounting/intercompany/inbox/${item.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) },
        'Could not reject this message - try again');
      setReason('');
      onDone(`Rejected ${item.number}. ${item.senderName} will see your reason.`);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not reject this message - try again'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal open={item !== null} onClose={busy ? () => undefined : onClose} title={item ? `Reject ${item.number}` : 'Reject'} size="md" initialFocusRef={field}>
      <Modal.Body>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3" id="ic-reject-form">
          <p className="text-sm text-ink-muted">
            Nothing is created in your books, and nothing changes in {item?.senderName ?? 'the sender'}&apos;s: the message is closed and your reason goes back to them.
          </p>
          <div>
            <label htmlFor="ic-reject-reason" className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Reason (required)</label>
            <textarea id="ic-reject-reason" ref={field} rows={4} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)}
              className="ff-input w-full text-sm" placeholder="For example: this belongs to another company in the group." />
          </div>
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </form>
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onClose} disabled={busy} className="px-3 py-2 text-sm rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50">Cancel</button>
        <button type="submit" form="ic-reject-form" disabled={busy}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Reject message
        </button>
      </Modal.Footer>
    </Modal>
  );
}
