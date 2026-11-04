/**
 * Cancel an APPROVED purchase order (budgets P5-3 review r2): POST /api/accounting/purchase-orders/[id]/cancel with
 * a mandatory reason. Releases the order's budget commitment; refused (the server's words shown) once goods have
 * been received. Rendered only for owner / admin (`canCancelApprovedPo`, the route's gate).
 */
import { useState } from 'react';
import { Ban } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useCompanyRoleOrNull } from '@/contexts/CompanyContext';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { canCancelApprovedPo } from '@/lib/auth/writeRoles';

const REASON_MAX = 2000;
const FALLBACK = 'Could not cancel the purchase order - try again';

interface Props {
  poId: string;
  onCancelled: () => Promise<void> | void;
}

export function PurchaseOrderCancelButton(props: Props) {
  const companyRole = useCompanyRoleOrNull();
  return canCancelApprovedPo(companyRole) ? <CancelButton {...props} /> : null;
}

function CancelButton({ poId, onCancelled }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders/${encodeURIComponent(poId)}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }),
      });
      await assertOk(res, FALLBACK);
      setOpen(false);
      await onCancelled();
    } catch (err) {
      setError(apiErrorMessage(err, FALLBACK));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => { setReason(''); setError(''); setOpen(true); }}
        className="inline-flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium">
        <Ban className="h-4 w-4" /> Cancel order
      </button>
      {open && (
        <Modal open={open} onClose={() => setOpen(false)} title="Cancel the approved purchase order" size="md">
          <Modal.Body className="space-y-3">
            <p className="text-sm text-[var(--ff-text-secondary)]">
              Cancelling releases this order&apos;s budget commitment. It cannot be undone, and is refused once goods have been received.
            </p>
            <label className="block text-sm text-[var(--ff-text-primary)]">
              <span className="block mb-1 font-medium">Reason <span className="text-red-500" aria-hidden="true">*</span></span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))} rows={3} required aria-required="true"
                disabled={busy} className="w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm"
                placeholder="Why this order is cancelled" />
            </label>
            {error && <p className="text-sm text-red-500" role="alert">{error}</p>}
          </Modal.Body>
          <Modal.Footer>
            <button type="button" onClick={() => setOpen(false)} disabled={busy}
              className="px-4 py-2 text-sm rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]">
              Keep order
            </button>
            <button type="button" onClick={() => void submit()} disabled={busy || reason.trim() === ''}
              className="px-4 py-2 text-sm font-semibold rounded-lg text-white bg-red-600 hover:bg-red-700 disabled:opacity-50">
              {busy ? 'Cancelling…' : 'Cancel order'}
            </button>
          </Modal.Footer>
        </Modal>
      )}
    </>
  );
}
