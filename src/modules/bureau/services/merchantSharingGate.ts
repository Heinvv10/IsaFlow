/**
 * Server-side hard gate on merchant-pattern sharing (Hein, 2026-10-21, decision 3): the POPIA consent copy
 * (sharingConsentCopy.ts) is a DRAFT pending legal review, so nobody can switch sharing ON, the bureau
 * owner included, until MERCHANT_SHARING_ENABLED=true is set on the server. Unset or anything else = off.
 *
 * While off: setBureauSharingSetting refuses `true` (switching OFF is always allowed), GET
 * /api/bureau/settings reports `sharingAvailable: false` so the page shows "Coming soon", and every pool
 * reader (poolEligibility.ts) treats every bureau as not opted in, whatever is stored.
 */

export const MERCHANT_SHARING_PENDING_CODE = 'sharing_pending_legal_review' as const;

export function isMerchantSharingEnabled(): boolean {
  return process.env.MERCHANT_SHARING_ENABLED === 'true';
}
