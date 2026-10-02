/**
 * Confirmation + call for revoking an invoice's standing "Pay now" link.
 * `onDone` runs after every attempt (the invoice is reloaded so a stale item disappears); on a
 * failure the server's message is then handed to `onError`.
 */
import { useState } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

interface Props {
  open: boolean;
  invoiceId: string;
  invoiceNumber: string;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export function RevokePaymentLinkDialog({ open, invoiceId, invoiceNumber, onClose, onDone, onError }: Props) {
  const [revoking, setRevoking] = useState(false);

  const revoke = async () => {
    setRevoking(true);
    try {
      await assertOk(
        await apiFetch(`/api/accounting/customer-invoices/${invoiceId}/payment-link/revoke`, { method: 'POST' }),
        'Failed to revoke payment link',
      );
      onDone();
    } catch (e) {
      onDone();
      onError(e instanceof Error ? e.message : 'Failed to revoke payment link');
    } finally {
      setRevoking(false);
      onClose();
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title="Revoke payment link?"
      message={<>Every Pay Now link on <strong>{invoiceNumber}</strong> will stop working for anyone who has it. Fixed-amount links created since 1 October 2026 are not affected, and a payment already started at Paystack can still complete. The next Pay Now creates a new link.</>}
      acceptLabel={revoking ? 'Revoking...' : 'Revoke link'}
      cancelLabel="Keep link"
      tone="destructive"
      loading={revoking}
      onAccept={() => { void revoke(); }}
      onCancel={onClose}
    />
  );
}
