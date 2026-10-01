/**
 * R-180: the Pay Now button is offered only for an invoice the server will accept — approved
 * (or later) with a balance. A draft and an invoice awaiting approval get no button.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { useCustomerInvoiceActions } from '@/modules/accounting/hooks/useCustomerInvoiceActions';

const noop = () => undefined;
function labels(status: string, amountPaid = 0): string[] {
  const { groups } = useCustomerInvoiceActions({
    invoiceId: 'inv-1',
    invoice: { status, total_amount: 115, amount_paid: amountPaid, client_id: 'c-1', online_payment_enabled: false, payment_url: null } as never,
    actionLoading: '', paymentLoading: false, portalLinkLoading: false, portalLinkCopied: false, linkCopied: false,
    onOpenEmailModal: noop, onCopyPortalLink: noop, onPayNow: noop, onCopyPaymentLink: noop, onAction: noop, onShowCancelConfirm: noop,
  });
  return groups.flatMap((g) => g.actions.map((a) => a.label));
}

describe('useCustomerInvoiceActions — Pay Now', () => {
  it.each(['approved', 'sent', 'overdue', 'partially_paid'])('is offered for a %s invoice with a balance', (status) => {
    expect(labels(status)).toContain('Pay Now');
  });

  it.each(['draft', 'pending_approval', 'paid', 'cancelled'])('is not offered for a %s invoice', (status) => {
    expect(labels(status)).not.toContain('Pay Now');
  });

  it('is not offered once nothing is owed', () => {
    expect(labels('sent', 115)).not.toContain('Pay Now');
  });
});
