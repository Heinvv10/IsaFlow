/**
 * Confirmation + call for revoking an invoice's standing "Pay now" link.
 * The server's message is handed to `onError`; `onRevoked` runs after a success.
 */
import { useState } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

interface Props {
  open: boolean;
  invoiceId: string;
  invoiceNumber: string;
  onClose: () => void;
  onRevoked: () => void;
  onError: (message: string) => void;
}

export function RevokePaymentLinkDialog({ open, invoiceId, invoiceNumber, onClose, onRevoked, onError }: Props) {
  const [revoking, setRevoking] = useState(false);

  const revoke = async () => {
    setRevoking(true);
    try {
      await assertOk(
        await apiFetch(`/api/accounting/customer-invoices/${invoiceId}/payment-link/revoke`, { method: 'POST' }),
        'Failed to revoke payment link',
      );
      onRevoked();
    } catch (e) {
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
      message={<>The Pay Now link for <strong>{invoiceNumber}</strong> will stop working for anyone who has it. A payment already started at Paystack can still complete. The next Pay Now creates a new link.</>}
      acceptLabel={revoking ? 'Revoking...' : 'Revoke link'}
      cancelLabel="Keep link"
      tone="destructive"
      loading={revoking}
      onAccept={() => { void revoke(); }}
      onCancel={onClose}
    />
  );
}
