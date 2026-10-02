/**
 * LINK-REVOKE: "Revoke payment link" is offered (overflow menu) only while the invoice names a
 * standing link in payment_url, and asks the page to confirm rather than revoking at once.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { useCustomerInvoiceActions } from '@/modules/accounting/hooks/useCustomerInvoiceActions';

const noop = () => undefined;
function overflow(paymentUrl: string | null, onShowRevokeConfirm: () => void = noop) {
  return useCustomerInvoiceActions({
    invoiceId: 'inv-1',
    invoice: { status: 'sent', total_amount: 115, amount_paid: 0, client_id: 'c-1', online_payment_enabled: !!paymentUrl, payment_url: paymentUrl } as never,
    actionLoading: '', paymentLoading: false, portalLinkLoading: false, portalLinkCopied: false, linkCopied: false,
    onOpenEmailModal: noop, onCopyPortalLink: noop, onPayNow: noop, onCopyPaymentLink: noop, onAction: noop,
    onShowCancelConfirm: noop, onShowRevokeConfirm,
  }).overflowActions;
}

describe('useCustomerInvoiceActions — Revoke payment link', () => {
  it('is offered when the invoice has a payment_url', () => {
    expect(overflow('https://app.test/portal/pay/abc').map((a) => a.label)).toContain('Revoke payment link');
  });

  it.each([null, ''])('is not offered when payment_url is %j', (url) => {
    expect(overflow(url).map((a) => a.label)).not.toContain('Revoke payment link');
  });

  it('opens the confirmation instead of revoking directly', () => {
    const open = vi.fn();
    overflow('https://app.test/portal/pay/abc', open).find((a) => a.label === 'Revoke payment link')!.onClick();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
