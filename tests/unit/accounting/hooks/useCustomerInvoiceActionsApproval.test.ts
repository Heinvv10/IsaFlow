/**
 * R-035 PR4: while an approval holds a customer invoice (required, pending,
 * stale) the actions hook offers no Approve — the page's DocumentApprovalPanel
 * offers Submit for approval instead. Approved, not required or no approval
 * state at all (enforcement off, an older server) keep Approve.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { useCustomerInvoiceActions } from '@/modules/accounting/hooks/useCustomerInvoiceActions';

const noop = () => undefined;
function labels(status: string, state?: string): string[] {
  const approval = state === undefined ? undefined
    : { state, enforced: state !== 'not_required', requiredRole: 'owner', ruleName: 'Owner signs', requestId: null };
  const { groups } = useCustomerInvoiceActions({
    invoiceId: 'inv-1',
    invoice: { status, total_amount: 115, amount_paid: 0, client_id: 'c-1', online_payment_enabled: false, payment_url: null, approval } as never,
    actionLoading: '', paymentLoading: false, portalLinkLoading: false, portalLinkCopied: false, linkCopied: false,
    onOpenEmailModal: noop, onCopyPortalLink: noop, onPayNow: noop, onCopyPaymentLink: noop, onAction: noop, onShowCancelConfirm: noop, onShowRevokeConfirm: noop,
  });
  return groups.flatMap((g) => g.actions.map((a) => a.label));
}

describe('useCustomerInvoiceActions — Approve under approval enforcement', () => {
  it.each(['required', 'pending', 'stale'])('hides Approve while the approval is %s', (state) => {
    expect(labels('draft', state)).not.toContain('Approve');
    expect(labels('pending_approval', state)).not.toContain('Approve');
  });

  it.each(['approved', 'not_required'])('offers Approve when the approval is %s', (state) => {
    expect(labels('draft', state)).toContain('Approve');
  });

  it('offers Approve when the server sent no approval state', () => {
    expect(labels('draft')).toContain('Approve');
  });
});
