/**
 * Payment Gateway Portal Service
 * Handles portal payment link generation and online payment enablement.
 * Re-exported from paymentGatewayService for backward compatibility.
 */

import { log } from '@/lib/logger';
import { ensureStandingLink, portalAppUrl } from '@/modules/accounting/services/ar/standingPaymentLink';
import { FOREIGN_INVOICE_ONLINE_PAYMENT } from '@/modules/accounting/services/shared/documentCurrency';

/** A draft, or an invoice awaiting approval, cannot be paid online yet (R-180). */
export class InvoiceNotApprovedError extends Error {
  constructor() {
    super('An invoice that is not approved cannot be paid online. Approve it first.');
    this.name = 'InvoiceNotApprovedError';
  }
}

/** A foreign-currency invoice cannot be paid online: the links charge rands (FX PR0, permanent). */
export class InvoiceForeignCurrencyError extends Error {
  constructor() {
    super(FOREIGN_INVOICE_ONLINE_PAYMENT);
    this.name = 'InvoiceForeignCurrencyError';
  }
}

/**
 * Enable online payment for an invoice and return its payment URL: the invoice's
 * standing link (`charges_balance`), which charges the live balance, is never spent
 * (R-167) and does not expire (R-179). An invoice that already has one keeps it.
 * Null (nothing written) when the invoice is not this company's, is cancelled or
 * soft-deleted, or has no balance due. Throws InvoiceNotApprovedError (nothing written)
 * for a draft or an invoice awaiting approval (R-180), and InvoiceForeignCurrencyError
 * (nothing written) for one not in rands (FX PR0). Needs the request transaction.
 */
export async function enableOnlinePayment(companyId: string, invoiceId: string): Promise<string | null> {
  // It used to fall back to http://localhost:3101, which was then stored on the invoice and emailed.
  const appUrl = portalAppUrl();
  if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is missing or points at localhost; refusing to mint a payment link');
  const link = await ensureStandingLink(companyId, invoiceId, appUrl);
  if (!link.ok && link.reason === 'invoice_unapproved') throw new InvoiceNotApprovedError();
  if (!link.ok && link.reason === 'foreign_currency') throw new InvoiceForeignCurrencyError();
  if (!link.ok) return null;
  const paymentUrl = link.paymentUrl;

  log.info('Online payment enabled', { invoiceId, paymentUrl }, 'PaymentGateway');
  return paymentUrl;
}
