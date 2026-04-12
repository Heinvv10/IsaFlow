/**
 * ISAFlow Email Templates — Barrel Index
 * Re-exports all email template functions and types from split files.
 * All existing imports from this path continue to work unchanged.
 *
 * Shared helpers (BRAND, layout, ctaButton, signature): email-templates-shared.ts
 * Invite template:                                      email-templates-invite.ts
 * Invoice template:                                     email-templates-invoice.ts
 * Auth templates (welcome, password-reset):             email-templates-auth.ts
 */

export {
  appendSignatureToHtml,
  BRAND,
  emailLayout,
  ctaButton,
} from './email-templates-shared';

export type { InviteEmailData } from './email-templates-invite';
export { inviteEmailHtml } from './email-templates-invite';

export type { InvoiceEmailData } from './email-templates-invoice';
export { invoiceEmailHtml } from './email-templates-invoice';
