/**
 * The invoice page's payment and portal links (moved out of pages/accounting/customer-invoices/[invoiceId].tsx to keep
 * it under 300 lines): Pay now, copy the payment link, generate and copy the portal link.
 */
import { useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { startPayNowCheckout } from '@/modules/accounting/utils/payNowCheckout';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import type { CustomerInvoiceDetail } from '@/modules/accounting/types/customerInvoice.types';

interface Args {
  invoiceId: string | string[] | undefined;
  invoice: CustomerInvoiceDetail | null;
  loadInvoice: () => Promise<void>;
  setError: (message: string) => void;
}

export function useInvoiceLinkActions({ invoiceId, invoice, loadInvoice, setError }: Args) {
  const afterLinkCopied = useTimeoutOnce();
  const afterPortalLinkCopied = useTimeoutOnce();
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [portalUrl, setPortalUrl] = useState('');
  const [portalLinkLoading, setPortalLinkLoading] = useState(false);
  const [portalLinkCopied, setPortalLinkCopied] = useState(false);

  const handlePayNow = async () => {
    setPaymentLoading(true);
    setError('');
    try {
      window.open(await startPayNowCheckout(invoiceId as string), '_blank', 'noopener,noreferrer');
      await loadInvoice();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not start the payment - try again'));
    } finally { setPaymentLoading(false); }
  };

  const handleCopyPaymentLink = async () => {
    if (!invoice?.payment_url) return;
    try {
      await navigator.clipboard.writeText(invoice.payment_url);
      setLinkCopied(true);
      afterLinkCopied(() => setLinkCopied(false), 2000);
    } catch { setError('Could not copy the link - copy it manually'); }
  };

  const handleCopyPortalLink = async () => {
    if (!invoiceId) return;
    setPortalLinkLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/portal/invoice/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId }),
      });
      await assertOk(res, 'Could not generate the portal link - try again');
      const json = await res.json() as { success: boolean; data?: { portalUrl: string } };
      if (!json.data?.portalUrl) throw new Error('Could not generate the portal link - try again');
      setPortalUrl(json.data.portalUrl);
      await navigator.clipboard.writeText(json.data.portalUrl);
      setPortalLinkCopied(true);
      afterPortalLinkCopied(() => setPortalLinkCopied(false), 3000);
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not generate the portal link - try again'));
    } finally { setPortalLinkLoading(false); }
  };

  return { paymentLoading, linkCopied, portalUrl, portalLinkLoading, portalLinkCopied, handlePayNow, handleCopyPaymentLink, handleCopyPortalLink };
}
